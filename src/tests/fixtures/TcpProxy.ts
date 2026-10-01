import { connect, createServer, type Socket } from "node:net";

export class TcpProxy {
	dropResponses = false;
	private readonly connections = new Map<Socket, Socket>();
	private readonly server;
	constructor(private readonly target: URL) {
		this.server = createServer({ allowHalfOpen: true }, (client) => {
			const upstream = connect({
				host: this.target.hostname,
				port: Number(this.target.port || 5432),
				allowHalfOpen: true,
			});
			this.connections.set(client, upstream);
			client.pipe(upstream);
			upstream.on("data", (data: Buffer) => {
				if (!this.dropResponses) client.write(data);
			});
			upstream.on("end", () => {
				if (!this.dropResponses) client.end();
			});
			upstream.on("error", () => {
				if (!this.dropResponses) client.destroy();
			});
			client.on("error", () => upstream.destroy());
			client.on("end", () => client.destroy());
			client.on("close", () => {
				upstream.destroy();
				this.connections.delete(client);
			});
		});
	}
	async start() {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", resolve);
		});
		const address = this.server.address();
		if (!address || typeof address === "string")
			throw new Error("Proxy listener address missing");
		const url = new URL(this.target);
		url.hostname = "127.0.0.1";
		url.port = String(address.port);
		return url.href;
	}
	closeConnections() {
		for (const [client, upstream] of this.connections) {
			client.destroy();
			upstream.destroy();
		}
		this.connections.clear();
	}
	async stop() {
		this.closeConnections();
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => (error ? reject(error) : resolve()));
		});
	}
}
