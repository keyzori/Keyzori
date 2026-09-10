import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { SessionRepository } from "../../src/sessions/SessionRepository.ts";
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
});
