import { RedisClient } from "bun";

export class Redis {
	readonly client;
	private closed = false;
	private connecting: Promise<void> | undefined;

	constructor(
		url: string,
		private readonly timeoutMs = 2000,
	) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
			throw new Error("Invalid Redis timeout");
		this.client = new RedisClient(url, {
			connectionTimeout: timeoutMs,
			idleTimeout: 0,
			autoReconnect: true,
			maxRetries: 2,
			enableOfflineQueue: false,
		});
	}

	async connect(deadlineAt?: number) {
		this.closed = false;
		await this.bounded(() => this.reconnect(), deadlineAt);
	}

	close() {
		this.closed = true;
		this.client.close();
	}

	async ping(deadlineAt?: number) {
		return (await this.send("PING", [], deadlineAt)) === "PONG";
	}

	async send(
		command: string,
		arguments_: string[],
		deadlineAt?: number,
	): Promise<unknown> {
		if (this.closed) throw new Error("Redis is closed");
		if (deadlineAt !== undefined && Date.now() >= deadlineAt)
			throw new Error("Redis operation timed out");
		if (!this.client.connected) {
			void this.reconnect().catch(() => {});
			throw new Error("Redis is disconnected");
		}
		try {
			return await this.bounded(
				() => this.client.send(command, arguments_),
				deadlineAt,
			);
		} catch (error) {
			if (!this.closed && !this.client.connected)
				void this.reconnect().catch(() => {});
			throw error;
		}
	}

	private reconnect() {
		if (this.connecting) return this.connecting;
		if (this.client.connected) return Promise.resolve();
		const connection = this.bounded(() => this.client.connect());
		this.connecting = connection;
		void connection.then(
			() => {
				this.connecting = undefined;
			},
			() => {
				this.connecting = undefined;
			},
		);
		return connection;
	}

	private async bounded<T>(operation: () => Promise<T>, deadlineAt?: number) {
		const timeout = Math.min(
			this.timeoutMs,
			deadlineAt === undefined ? Infinity : deadlineAt - Date.now(),
		);
		if (!Number.isFinite(timeout) || timeout < 1)
			throw new Error("Redis operation timed out");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(new Error("Redis operation timed out"));
						this.client.close();
					}, timeout);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
}
