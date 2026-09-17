import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { SessionRepository } from "../../src/sessions/SessionRepository.ts";
import { ActivityRepository } from "../../src/activity/ActivityRepository.ts";
import { LicenseRepository } from "../../src/licenses/LicenseRepository.ts";
import { LicensePolicy } from "../../src/licenses/LicensePolicy.ts";
import { AccessRepository } from "../../src/access/AccessRepository.ts";
import { SessionService } from "../../src/sessions/SessionService.ts";
import { digest } from "../../src/shared/security.ts";

describe.skipIf(!integrationAvailable)("session storage integrity", () => {
	let ctx: TestContext;
	let repository: SessionRepository;
	beforeAll(async () => {
		ctx = await new TestContext().start();
		repository = new SessionRepository(ctx.app.services.redis);
	});
	afterAll(async () => {
		await ctx?.close();
	});
	test.each([
		"not-json",
		"{}",
		"null",
		"[]",
		'{"licenseId":"bad","deviceHash":"short","revision":0,"ip":"127.0.0.1"}',
	])("corrupt session %s fails closed", async (raw) => {
		const id = digest(crypto.randomUUID());
		await ctx.app.services.redis.set(repository.key(id), raw);
		try {
			await expect(repository.get(id)).rejects.toMatchObject({
				code: "SESSION_INVALID",
				status: 401,
			});
		} finally {
			await ctx.app.services.redis.del(repository.key(id));
		}
	});
	test("refresh cannot replace a record that changed after it was read", async () => {
		const license = await ctx.license();
		const session = await ctx.activate(license.key);
		const id = digest(session.token);
		const previous = await repository.get(id);
		const changed = JSON.stringify({
			...previous.record,
			deviceHash: digest("other-device"),
		});
		await ctx.app.services.redis.set(repository.key(id), changed);
		await expect(
			repository.refresh(id, previous.record, previous.raw, 60),
		).rejects.toMatchObject({ code: "SESSION_INVALID" });
		expect(await ctx.app.services.redis.get(repository.key(id))).toBe(changed);
		await repository.remove(id, previous.record);
	});
	test("session listing paginates and termination frees only the requested session", async () => {
		const license = await ctx.license();
		await ctx.app.services.access.policy(license.id, { maxSessions: 3 });
		const sessions = await Promise.all(
			Array.from({ length: 3 }, () => ctx.activate(license.key)),
		);
		const page = await ctx.app.services.sessions.list({
			licenseId: license.id,
			limit: "2",
		});
		expect(page.items).toHaveLength(2);
		expect(page.hasMore).toBe(true);
		const last = await ctx.app.services.sessions.list({
			licenseId: license.id,
			limit: "2",
			offset: "2",
		});
		expect(last.items).toHaveLength(1);
		expect(last.hasMore).toBe(false);
		const first = sessions[0];
		if (!first) throw new Error("Missing session");
		await ctx.app.services.sessions.terminate(license.id, digest(first.token));
		expect(
			(await ctx.app.services.sessions.list({ licenseId: license.id })).items,
		).toHaveLength(2);
		await expect(ctx.activate(license.key)).resolves.toBeDefined();
		await ctx.app.services.sessions.terminateAll(license.id);
		expect(
			(await ctx.app.services.sessions.list({ licenseId: license.id })).items,
		).toHaveLength(0);
	});
	test("admission builds an absent index and enforces its limit", async () => {
		const record = {
			licenseId: crypto.randomUUID(),
			revision: 1,
			deviceHash: digest("device"),
			ip: "127.0.0.1",
		};
		const id = digest(crypto.randomUUID());
		const index = repository.index(record);
		try {
			expect(await ctx.app.services.redis.send("EXISTS", [index])).toBe(0);
			await repository.admit(id, record, 60, 1);
			expect(
				await repository.list(record.licenseId, 1, { limit: 10, offset: 0 }),
			).toHaveLength(1);
			expect(
				Number(await ctx.app.services.redis.send("PTTL", [index])),
			).toBeGreaterThan(0);
			await expect(
				repository.admit(digest(crypto.randomUUID()), record, 60, 1),
			).rejects.toMatchObject({ code: "SESSION_LIMIT" });
		} finally {
			await repository.remove(id, record);
		}
	});
	test("refresh rebuilds a removed index with membership and expiry", async () => {
		const license = await ctx.license();
		const session = await ctx.activate(license.key);
		const id = digest(session.token);
		const { record, raw } = await repository.get(id);
		const index = repository.index(record);
		try {
			await ctx.app.services.redis.del(index);
			await repository.refresh(id, record, raw, 60);
			expect((await repository.get(id)).raw).toBe(raw);
			expect(
				await repository.list(license.id, record.revision, {
					limit: 10,
					offset: 0,
				}),
			).toHaveLength(1);
			expect(
				Number(await ctx.app.services.redis.send("PTTL", [index])),
			).toBeGreaterThan(0);
		} finally {
			await repository.remove(id, record);
		}
	});
	test("terminate-all physically deletes the previous revision's keys", async () => {
		const license = await ctx.license();
		await ctx.app.services.access.policy(license.id, { maxSessions: 2 });
		const sessions = await Promise.all([
			ctx.activate(license.key),
			ctx.activate(license.key),
		]);
		const ids = sessions.map((session) => digest(session.token));
		const first = ids[0];
		if (!first) throw new Error("Missing session");
		const { record } = await repository.get(first);
		const index = repository.index(record);
		expect(Number(await ctx.app.services.redis.send("ZCARD", [index]))).toBe(2);
		await ctx.app.services.sessions.terminateAll(license.id);
		for (const id of ids)
			expect(await ctx.app.services.redis.get(repository.key(id))).toBeNull();
		expect(await ctx.app.services.redis.send("EXISTS", [index])).toBe(0);
		const next = await ctx.activate(license.key);
		await repository.removeAll(license.id, record.revision);
		expect((await repository.get(digest(next.token))).record.revision).toBe(
			record.revision + 1,
		);
	});
	test.each(["audit", "commit"])(
		"terminate-all preserves sessions when %s fails",
		async (stage) => {
			const license = await ctx.license();
			const session = await ctx.activate(license.key);
			const id = digest(session.token);
			const { record, raw } = await repository.get(id);
			const { database, redis, logger } = ctx.app.services;
			const activity = new ActivityRepository(database.orm);
			const failure =
				stage === "audit"
					? spyOn(activity, "write").mockImplementation(() => {
							throw new Error("forced audit failure");
						})
					: undefined;
			if (stage === "commit") {
				await database.orm.execute(
					sql`CREATE FUNCTION fail_termination_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'session.terminated_all' THEN RAISE EXCEPTION 'forced commit failure'; END IF; RETURN NEW; END $$`,
				);
				await database.orm.execute(
					sql`CREATE CONSTRAINT TRIGGER fail_termination_commit AFTER INSERT ON activity DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_termination_commit()`,
				);
			}
			const service = new SessionService({
				database,
				repository,
				licenses: new LicenseRepository(database),
				policy: new LicensePolicy(),
				access: new AccessRepository(database.orm),
				activity,
				ttl: 60,
				logger,
			});
			try {
				await expect(service.terminateAll(license.id)).rejects.toThrow();
			} finally {
				failure?.mockRestore();
				if (stage === "commit") {
					await database.orm.execute(
						sql`DROP TRIGGER fail_termination_commit ON activity`,
					);
					await database.orm.execute(
						sql`DROP FUNCTION fail_termination_commit()`,
					);
				}
			}
			expect(
				(await ctx.app.services.licenses.get(license.id)).policyRevision,
			).toBe(record.revision);
			expect(await redis.get(repository.key(id))).toBe(raw);
			expect(
				Number(await redis.send("ZCARD", [repository.index(record)])),
			).toBe(1);
			await expect(
				ctx.app.services.sessions.heartbeat({
					token: session.token,
					deviceId: "test-device",
					ip: "127.0.0.1",
				}),
			).resolves.toBeDefined();
		},
	);
});
