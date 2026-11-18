import { RedisClient } from "bun";

class RedisFault extends Error {
	constructor(
		readonly code:
			"TIMEOUT" | "CONNECTION_FAILED" | "REDIS_CAPACITY" | "REDIS_CLOSED",
		message: string,
	) {
		super(message);
	}
}

type Generation = {
	client: RedisClient;
	pending: Set<(error: unknown) => void>;
	connecting?: Promise<void>;
	retired: boolean;
};

export class Redis {
	readonly #url: string;
	private current: Generation;
	private closed = false;
	private nextRecoveryAt = 0;

	constructor(
		url: string,
		private readonly timeoutMs = 2000,
		private readonly maxPending = 256,
	) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
			throw new Error("Invalid Redis timeout");
		if (
			!Number.isSafeInteger(maxPending) ||
			maxPending < 1 ||
			maxPending > 16384
		)
			throw new Error("Invalid Redis command capacity");
		this.#url = url;
		this.current = this.generation();
	}
	get client() {
		return this.current.client;
	}
	private generation(): Generation {
		return {
			client: new RedisClient(this.#url, {
				connectionTimeout: this.timeoutMs,
				idleTimeout: 0,
				autoReconnect: false,
				enableOfflineQueue: false,
			}),
			pending: new Set(),
			retired: false,
		};
	}
	async connect(deadlineAt?: number) {
		const remaining = this.remaining(deadlineAt);
		this.closed = false; // Only an explicit connect may reopen an intentionally closed client.
		await this.wait(this.connection(), remaining);
	}
	close() {
		this.closed = true;
		this.retire(
			this.current,
			new RedisFault("REDIS_CLOSED", "Redis is closed"),
		);
	}
	async ping(deadlineAt?: number) {
		return (await this.send("PING", [], deadlineAt)) === "PONG";
	}
	async send(
		command: string,
		args: string[],
		deadlineAt?: number,
	): Promise<unknown> {
		if (this.closed) throw new RedisFault("REDIS_CLOSED", "Redis is closed");
		const remaining = this.remaining(deadlineAt);
		const generation = this.current;
		if (generation.retired || !generation.client.connected) {
			this.recover();
			throw new RedisFault("CONNECTION_FAILED", "Redis is disconnected");
		}
		if (generation.pending.size >= this.maxPending)
			throw new RedisFault("REDIS_CAPACITY", "Redis command capacity exceeded");
		const sent = this.watch(
			generation,
			() => generation.client.send(command, args),
			true,
		);
		// Expiring a caller does not remove the wire operation's slot, close the
		// socket, or replay a command whose result is now unknown to the caller.
		return this.wait(sent, remaining);
	}
	private remaining(deadlineAt?: number) {
		if (deadlineAt === undefined) return Infinity;
		const remaining = deadlineAt - Date.now();
		if (!Number.isSafeInteger(remaining) || remaining <= 0)
			throw new RedisFault("TIMEOUT", "Redis operation timed out");
		return remaining;
	}
	private async wait<T>(wire: Promise<T>, remaining: number) {
		if (remaining >= this.timeoutMs) return wire;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				wire,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(new RedisFault("TIMEOUT", "Redis operation timed out")),
						remaining,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	private connection(): Promise<void> {
		if (!this.current.retired && this.current.connecting)
			return this.current.connecting;
		if (!this.current.retired && this.client.connected)
			return Promise.resolve();
		if (this.current.retired) this.current = this.generation();
		const generation = this.current;
		generation.connecting = this.watch(
			generation,
			() => generation.client.connect(),
			false,
		)
			.then(() => {
				if (generation !== this.current || generation.retired || this.closed)
					throw new RedisFault("REDIS_CLOSED", "Redis connection was retired");
				this.nextRecoveryAt = 0;
			})
			.finally(() => {
				generation.connecting = undefined;
			});
		return generation.connecting;
	}
	private recover() {
		if (
			this.closed ||
			this.current.connecting ||
			performance.now() < this.nextRecoveryAt
		)
			return;
		this.nextRecoveryAt = performance.now() + 250;
		if (!this.current.retired)
			this.retire(
				this.current,
				new RedisFault("CONNECTION_FAILED", "Redis is disconnected"),
			);
		void this.connection().catch(() => {});
	}
	private retire(generation: Generation, error: unknown) {
		if (generation.retired) return;
		generation.retired = true;
		for (const reject of generation.pending) reject(error);
		generation.client.close();
	}
	/** A real transport stall retires exactly one generation, including its pending sends. */
	private watch<T>(
		generation: Generation,
		work: () => Promise<T>,
		recover: boolean,
	) {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.retire(
					generation,
					new RedisFault("TIMEOUT", "Redis operation timed out"),
				);
				if (recover && this.current === generation) this.recover();
			}, this.timeoutMs);
			const fail = (error: unknown) => {
				if (!generation.pending.delete(fail)) return;
				clearTimeout(timer);
				reject(error);
			};
			const failed = (error: unknown) => {
				if (!generation.pending.has(fail)) return;
				fail(error);
				if (!recover || !generation.client.connected) {
					this.retire(generation, error);
					if (recover && this.current === generation) this.recover();
				}
			};
			generation.pending.add(fail);
			try {
				void work().then((value) => {
					if (!generation.pending.delete(fail)) return;
					clearTimeout(timer);
					resolve(value);
				}, failed);
			} catch (error) {
				failed(error);
			}
		});
	}
}
