import { expect, test } from "bun:test";
import { Redis } from "../../core/redis/Redis";

test("Redis construction is inert and closes a nonresponsive transport within its deadline", async () => {
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const redis = new Redis(`redis://127.0.0.1:${listener.port}`, 100);
	try {
		expect(redis.client.connected).toBe(false);
		const started = performance.now();
		await expect(redis.connect()).rejects.toThrow();
		expect(performance.now() - started).toBeLessThan(1500);
		expect(redis.client.connected).toBe(false);
	} finally {
		redis.close();
		listener.stop(true);
	}
});

test("a short wait cannot abort a healthy pipeline, free a wire slot, or retry an uncertain command", async () => {
	const hello = "*2\r\n$5\r\nHELLO\r\n$1\r\n3\r\n";
	const ping = "*1\r\n$4\r\nPING\r\n";
	const arrived = Promise.withResolvers<void>();
	let commands = 0;
	let handshakes = 0;
	let flush = () => {};
	// A controlled TCP peer holds both replies until the short caller has left.
	// Parse the two fixed RESP frames across arbitrary TCP read boundaries.
	const listener = Bun.listen<{ buffered: string }>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = { buffered: "" };
			},
			data(socket, bytes) {
				socket.data.buffered += bytes.toString();
				while (socket.data.buffered) {
					const frame = [hello, ping].find((f) =>
						socket.data.buffered.startsWith(f),
					);
					if (!frame) return;
					socket.data.buffered = socket.data.buffered.slice(frame.length);
					if (frame === hello) {
						handshakes++;
						socket.write("%1\r\n+proto\r\n:3\r\n");
					} else {
						commands++;
						if (commands === 2) {
							flush = () => {
								socket.write("+PONG\r\n+PONG\r\n");
							};
							arrived.resolve();
						} else if (commands > 2) socket.write("+PONG\r\n");
					}
				}
			},
		},
	});
	const redis = new Redis(`redis://127.0.0.1:${listener.port}`, 1500, 2);
	try {
		await redis.connect();
		const short = expect(redis.ping(Date.now() + 50)).rejects.toMatchObject({
			code: "TIMEOUT",
		});
		const long = redis.ping();
		await Promise.all([arrived.promise, short]);
		await expect(redis.ping()).rejects.toMatchObject({
			code: "REDIS_CAPACITY",
		});
		flush();
		expect(await long).toBe(true);
		expect(await redis.ping()).toBe(true);
		expect(commands).toBe(3);
		expect(handshakes).toBe(1);
	} finally {
		redis.close();
		listener.stop(true);
	}
});
