/** A backend WebSocket client. Persist each batch and cursor together before resolving handle. */
export async function streamEvents(options: {
	url: string;
	apiKey: string;
	loadCursor(): Promise<string | undefined>;
	handle(events: readonly unknown[], nextCursor: string): Promise<void>;
	signal: AbortSignal;
}) {
	let attempt = 0;
	while (!options.signal.aborted) {
		const cursor = await options.loadCursor();
		const socket = new WebSocket(options.url, {
			headers: { authorization: `Bearer ${options.apiKey}` },
		});
		let processing = Promise.resolve();
		let failure: Error | undefined;
		let readyAt = 0;
		let queued = 0;
		let lastMessage = Date.now();
		const close = () => socket.terminate();
		const closed = new Promise<void>((resolve) =>
			socket.addEventListener("close", () => resolve(), { once: true }),
		);
		options.signal.addEventListener("abort", close, { once: true });
		const deadline = setTimeout(() => socket.terminate(), 15000);
		const heartbeat = setInterval(() => {
			if (Date.now() - lastMessage > 40000) socket.terminate();
		}, 10000);
		socket.addEventListener("message", ({ data }) => {
			lastMessage = Date.now();
			if (
				failure ||
				++queued > 32 ||
				typeof data !== "string" ||
				Buffer.byteLength(data) > 262144
			) {
				failure ??= new Error(
					"Stream consumer exceeded its queue or frame limit",
				);
				socket.terminate();
				return;
			}
			processing = processing
				.then(async () => {
					if (failure || options.signal.aborted) return;
					const frame: unknown =
						typeof data === "string" ? JSON.parse(data) : null;
					if (!frame || typeof frame !== "object" || !("type" in frame))
						throw new Error("Invalid stream frame");
					if (frame.type === "ready") {
						clearTimeout(deadline);
						readyAt = Date.now();
						socket.send(JSON.stringify({ type: "subscribe", cursor }));
					} else if (
						frame.type === "events" &&
						"data" in frame &&
						Array.isArray(frame.data) &&
						"cursor" in frame &&
						typeof frame.cursor === "string"
					) {
						await options.handle(frame.data, frame.cursor);
					} else if (
						frame.type === "error" &&
						"code" in frame &&
						frame.code === "CURSOR_EXPIRED"
					) {
						throw new Error(
							"Cursor expired: resynchronise authorised state before restarting this client",
						);
					}
				})
				.catch((error: unknown) => {
					failure =
						error instanceof Error
							? error
							: new Error("Event processing failed");
					socket.terminate();
				})
				.finally(() => {
					queued--;
				});
		});
		if (options.signal.aborted) close();
		try {
			await closed;
			await processing;
		} finally {
			clearTimeout(deadline);
			clearInterval(heartbeat);
			options.signal.removeEventListener("abort", close);
		}
		if (failure) throw failure;
		if (options.signal.aborted) return;
		if (readyAt && Date.now() - readyAt > 30000) attempt = 0;
		const delay =
			Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)) *
			(0.8 + Math.random() * 0.4);
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				options.signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, delay);
			options.signal.addEventListener("abort", done, { once: true });
			if (options.signal.aborted) done();
		});
	}
}
