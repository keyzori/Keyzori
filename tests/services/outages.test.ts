import { describe, expect, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { TcpProxy } from "../helpers/TcpProxy.ts";

describe.skipIf(!integrationAvailable)(
	"real dependency connection loss",
	() => {
		test("Redis outage rejects admission/runtime, then recovers without registration leaks", async () => {
			const redisUrl = new URL(process.env.KEYZORI_TEST_REDIS_URL ?? "");
			const proxy = await new TcpProxy(
				redisUrl.hostname,
				Number(redisUrl.port || 6379),
			).start();
			redisUrl.hostname = "127.0.0.1";
			redisUrl.port = String(proxy.port);
			const ctx = new TestContext({ KEYZORI_REDIS_URL: redisUrl.href });
			try {
				await ctx.start();
				const license = await ctx.license("trial");
				proxy.disconnect();
				await Bun.sleep(50);
				expect((await ctx.request("/ready")).status).toBe(503);
				expect((await ctx.request("/health")).status).toBe(200);
				await expect(ctx.activate(license.key)).rejects.toBeDefined();
				expect(
					(await ctx.app.services.licenses.get(license.id)).trial?.activatedAt,
				).toBeNull();
				expect(
					(await ctx.app.services.access.devices(license.id, {})).items,
				).toHaveLength(0);
				proxy.reconnect();
				for (let attempt = 0; attempt < 50; attempt++) {
					if ((await ctx.request("/ready")).status === 200) break;
					await Bun.sleep(100);
				}
				await expect(ctx.activate(license.key)).resolves.toBeDefined();
			} finally {
				await ctx.close();
				await proxy.close();
			}
		}, 20000);
		test("PostgreSQL outage fails runtime and readiness while liveness remains available", async () => {
			const ctx = new TestContext();
			const databaseUrl = new URL(ctx.env.KEYZORI_DATABASE_URL ?? "");
			const proxy = await new TcpProxy(
				databaseUrl.hostname,
				Number(databaseUrl.port || 5432),
			).start();
			try {
				await ctx.start();
				const license = await ctx.license();
				const session = await ctx.activate(license.key);
				databaseUrl.hostname = "127.0.0.1";
				databaseUrl.port = String(proxy.port);
				await ctx.restart({ KEYZORI_DATABASE_URL: databaseUrl.href });
				proxy.disconnect();
				await Bun.sleep(50);
				expect((await ctx.request("/ready")).status).toBe(503);
				expect((await ctx.request("/health")).status).toBe(200);
				expect(
					(
						await ctx.request(
							"/sessions/heartbeat",
							"POST",
							{},
							{
								Authorization: `Bearer ${session.token}`,
								"X-Device-Id": "test-device",
							},
						)
					).status,
				).toBe(503);
				proxy.reconnect();
				expect(
					(await ctx.request(`/admin/licenses/${license.id}`)).status,
				).toBe(200);
			} finally {
				await ctx.close();
				await proxy.close();
			}
		}, 20000);
	},
);
