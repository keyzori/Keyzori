import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpError } from "../../core/http/HttpError";
import { RateLimiter } from "../../core/http/RateLimiter";
import { Redis } from "../../core/redis/Redis";
import { SecretHasher } from "../../core/security/SecretHasher";

const url = process.env.KZ_TEST_REDIS_URL;
if (!url)
	throw new Error(
		"KZ_TEST_REDIS_URL is required for real Redis rate-limit tests",
	);
const redis = new Redis(url);
const limiter = new RateLimiter(redis);
const hasher = new SecretHasher();
const keys: string[] = [];

beforeAll(async () => {
	await redis.connect();
});
afterAll(async () => {
	try {
		if (keys.length) await redis.send("DEL", keys);
	} finally {
		redis.close();
	}
});

describe("shared Redis rate limits", () => {
	test("concurrent requests admit exactly the threshold and carry a bounded retry delay", async () => {
		const bucket = `test:${Bun.randomUUIDv7()}`;
		const key = `kz:rate:${hasher.hash(bucket)}`;
		keys.push(key);
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, () => limiter.check(bucket, 5)),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(5);
		for (const result of results) {
			if (result.status === "fulfilled") continue;
			expect(result.reason).toBeInstanceOf(HttpError);
			if (!(result.reason instanceof HttpError))
				throw new Error("Unexpected rate-limit failure");
			expect(result.reason.code).toBe("RATE_LIMITED");
			expect(result.reason.retryAfter).toBeGreaterThanOrEqual(1);
			expect(result.reason.retryAfter).toBeLessThanOrEqual(60);
		}
		expect(await redis.send("GET", [key])).toBe("20");
	});

	test("first request starts a 60-second window and later requests do not extend it", async () => {
		const bucket = `test:${Bun.randomUUIDv7()}`;
		const key = `kz:rate:${hasher.hash(bucket)}`;
		keys.push(key);
		await limiter.check(bucket, 2);
		const initial = await redis.send("PTTL", [key]);
		expect(initial).toBeGreaterThan(59000);
		expect(initial).toBeLessThanOrEqual(60000);
		await redis.send("PEXPIRE", [key, "1000"]);
		await limiter.check(bucket, 2);
		expect(await redis.send("PTTL", [key])).toBeLessThanOrEqual(1000);
		await expect(limiter.check(bucket, 2)).rejects.toMatchObject({
			code: "RATE_LIMITED",
			retryAfter: 1,
		});
		await redis.send("PEXPIRE", [key, "20"]);
		await Bun.sleep(40);
		await limiter.check(bucket, 2);
		expect(await redis.send("GET", [key])).toBe("1");
		expect(await redis.send("PTTL", [key])).toBeGreaterThan(59000);
	});

	test("independent principal/IP buckets remain isolated", async () => {
		const id = Bun.randomUUIDv7();
		const first = `api:${id}:192.0.2.1`;
		const second = `api:${id}:192.0.2.2`;
		keys.push(
			`kz:rate:${hasher.hash(first)}`,
			`kz:rate:${hasher.hash(second)}`,
		);
		await limiter.check(first, 1);
		await expect(limiter.check(first, 1)).rejects.toMatchObject({
			code: "RATE_LIMITED",
		});
		await expect(limiter.check(second, 1)).resolves.toBeUndefined();
	});

	test("lost native Redis connection fails unavailable without a local allowance", async () => {
		const unavailable = new Redis(url, 100);
		await unavailable.connect();
		unavailable.close();
		const started = performance.now();
		await expect(
			new RateLimiter(unavailable).check(`test:${Bun.randomUUIDv7()}`, 100),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
