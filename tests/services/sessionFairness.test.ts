import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";

describe.skipIf(!integrationAvailable)("session database pool fairness", () => {
	test("a locked license does not starve another license's heartbeat", async () => {
		const ctx = await new TestContext().start();
		const blocker = new SQL(ctx.env.KEYZORI_DATABASE_URL!, { max: 1 });
		const locked = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let transaction: Promise<unknown> | undefined;
		let requests: Promise<unknown>[] = [];
		try {
			const busy = await ctx.license(),
				other = await ctx.license();
			const a = await ctx.activate(busy.key),
				b = await ctx.activate(other.key);
			transaction = blocker.begin(async (tx) => {
				await tx`SELECT id FROM licenses WHERE id = ${busy.id} FOR UPDATE`;
				locked.resolve();
				await release.promise;
			});
			await locked.promise;
			const identity = {
				token: a.token,
				deviceId: "test-device",
				ip: "127.0.0.1",
			};
			requests = Array.from({ length: 32 }, () =>
				ctx.app.services.sessions.heartbeat(identity),
			);
			await Bun.sleep(100);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					ctx.app.services.sessions.heartbeat({ ...identity, token: b.token }),
					new Promise<never>((_, reject) => {
						timeout = setTimeout(
							() =>
								reject(
									new Error("Unrelated session starved by locked license"),
								),
							1500,
						);
					}),
				]);
				expect(result.licenseId).toBe(other.id);
			} finally {
				clearTimeout(timeout);
			}
		} finally {
			release.resolve();
			await transaction;
			await Promise.allSettled(requests);
			await blocker.close();
			await ctx.close();
		}
	});
});
