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
