import { createConnection, createServer, type Socket } from "node:net";

export class TcpProxy {
	private readonly sockets = new Set<Socket>();
	private enabled = true;
	private readonly server;
	constructor(host: string, port: number) {
		this.server = createServer((client) => {
			if (!this.enabled) {
				client.destroy();
				return;
			}
			const upstream = createConnection({ host, port });
			for (const socket of [client, upstream]) {
				this.sockets.add(socket);
				socket.on("close", () => this.sockets.delete(socket));
				socket.on("error", () => {
					client.destroy();
					upstream.destroy();
				});
			}
			client.pipe(upstream).pipe(client);
		});
	}
	async start() {
		await new Promise<void>((resolve) =>
			this.server.listen(0, "127.0.0.1", resolve),
		);
		return this;
	}
	get port() {
		const address = this.server.address();
		if (!address || typeof address === "string")
			throw new Error("Proxy not listening");
		return address.port;
	}
	disconnect() {
		this.enabled = false;
		for (const socket of this.sockets) socket.destroy();
	}
	reconnect() {
		this.enabled = true;
	}
	async close() {
		this.disconnect();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}
