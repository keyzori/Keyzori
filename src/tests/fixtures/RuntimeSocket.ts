import assert from "node:assert/strict";

/** Real Bun client used unchanged against the source process and tested image. */
export class RuntimeSocket {
	private readonly socket;
	private readonly frames: unknown[] = [];
	private wake: (() => void) | undefined;
	private failure: Error | undefined;
	readonly closed: Promise<CloseEvent>;
	constructor(origin: URL, credential: string) {
		const url = new URL("/events/stream", origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		this.socket = new WebSocket(url, {
			headers: { Authorization: `Bearer ${credential}` },
		});
		this.closed = new Promise((resolve) =>
			this.socket.addEventListener(
				"close",
				(event) => {
					this.failure ??= new Error(`Stream closed (${event.code})`);
					this.wake?.();
					resolve(event);
				},
				{ once: true },
			),
		);
		this.socket.addEventListener("message", (event) => {
			try {
				this.frames.push(JSON.parse(String(event.data)));
			} catch {
				this.failure = new Error("Invalid stream JSON");
			}
			this.wake?.();
		});
		this.socket.addEventListener("error", () => {
			this.failure = new Error("Stream handshake or transport failed");
			this.wake?.();
		});
	}
	async next(timeoutMs = 10000): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		while (!this.frames.length) {
			if (this.failure) throw this.failure;
			assert.ok(Date.now() < deadline, "Stream frame deadline exceeded");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
				this.wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.wake = undefined;
		}
		const frame = this.frames.shift();
		assert.ok(frame && typeof frame === "object" && !Array.isArray(frame));
		return Object.fromEntries(Object.entries(frame));
	}
	async subscribe(cursor?: string) {
		assert.equal((await this.next()).type, "ready");
		this.socket.send(
			JSON.stringify({ type: "subscribe", ...(cursor ? { cursor } : {}) }),
		);
	}
	async closeCode(timeoutMs = 10000) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return (
				await Promise.race([
					this.closed,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error("Stream close deadline exceeded")),
							timeoutMs,
						);
					}),
				])
			).code;
		} finally {
			clearTimeout(timer);
		}
	}
	close() {
		this.socket.terminate();
	}
}
