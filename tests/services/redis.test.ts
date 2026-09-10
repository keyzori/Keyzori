import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { SessionRepository } from "../../src/sessions/SessionRepository.ts";
import { RateLimiter } from "../../src/shared/RateLimiter.ts";
import { digest } from "../../src/shared/security.ts";

describe.skipIf(!integrationAvailable)(
	"Redis expiration and rate limits",
	() => {
		let ctx: TestContext;
		beforeAll(async () => {
			ctx = await new TestContext().start();
		});
		afterAll(async () => {
			await ctx?.close();
		});
		test("atomic fixed-window rate counter", async () => {
			const limiter = new RateLimiter(ctx.app.services.redis, 3);
			const attempts = await Promise.allSettled(
				Array.from({ length: 20 }, () => limiter.check("127.0.0.1", ctx.name)),
			);
			expect(
				attempts.filter((attempt) => attempt.status === "fulfilled"),
			).toHaveLength(3);
			const ttl = Number(
				await ctx.app.services.redis.send("TTL", [
					`keyzori:v2:rate:${ctx.name}:${digest("127.0.0.1")}`,
				]),
			);
			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(60);
		});
		test("expired sessions cannot heartbeat and release slots", async () => {
			const repository = new SessionRepository(ctx.app.services.redis);
			const record = {
				licenseId: crypto.randomUUID(),
				deviceHash: digest("device"),
				ip: "127.0.0.1",
				revision: 1,
			};
			const id = digest(`first${ctx.name}`);
			const replacement = digest(`second${ctx.name}`);
			await repository.admit(id, record, 0.05, 1);
			await Bun.sleep(80);
			await expect(repository.get(id)).rejects.toMatchObject({
				code: "SESSION_INVALID",
			});
			await expect(
				repository.refresh(id, record, JSON.stringify(record), 60),
			).rejects.toMatchObject({ code: "SESSION_INVALID" });
			await expect(
				repository.admit(replacement, record, 60, 1),
			).resolves.toBeUndefined();
			await repository.remove(replacement, record);
		});
		test("short TTL admissions and heartbeats cannot expire a longer session index", async () => {
			const repository = new SessionRepository(ctx.app.services.redis);
			const record = {
				licenseId: crypto.randomUUID(),
				deviceHash: digest("device"),
				ip: "127.0.0.1",
				revision: 1,
			};
			const long = digest(`long${ctx.name}`);
			const short = digest(`short${ctx.name}`);
			await repository.admit(long, record, 60, 2);
			await repository.admit(short, record, 0.05, 2);
			await repository.refresh(short, record, JSON.stringify(record), 0.05);
			await Bun.sleep(80);
			expect(
				Number(
					await ctx.app.services.redis.send("TTL", [repository.index(record)]),
				),
			).toBeGreaterThan(50);
			await expect(
				repository.admit(digest(`extra${ctx.name}`), record, 60, 1),
			).rejects.toMatchObject({ code: "SESSION_LIMIT" });
			await repository.remove(long, record);
		});
	},
);
