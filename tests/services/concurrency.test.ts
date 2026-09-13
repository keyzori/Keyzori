import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { ActivityRepository } from "../../src/activity/ActivityRepository.ts";
import { SessionRepository } from "../../src/sessions/SessionRepository.ts";
import { LicenseRepository } from "../../src/licenses/LicenseRepository.ts";
import { LicensePolicy } from "../../src/licenses/LicensePolicy.ts";
import { AccessRepository } from "../../src/access/AccessRepository.ts";
import { SessionService } from "../../src/sessions/SessionService.ts";
import { SessionWorkQueue } from "../../src/sessions/SessionWorkQueue.ts";
import { trials, subscriptions } from "../../src/licenses/tables.ts";
import { activity } from "../../src/activity/tables.ts";
import { digest } from "../../src/shared/security.ts";

describe.skipIf(!integrationAvailable)(
	"transactional licensing and sessions",
	() => {
		let ctx: TestContext;
		beforeAll(async () => {
			ctx = await new TestContext().start();
		});
		afterAll(async () => {
			await ctx?.close();
		});
		test("trial constraints reject partial activation and expiry closes existing sessions", async () => {
			const license = await ctx.license("trial");
			const activatePartially = async () => {
				await ctx.app.services.database
					.sql`UPDATE license_trials SET "activatedAt" = now() WHERE "licenseId" = ${license.id}`;
			};
			await expect(activatePartially()).rejects.toThrow("trial_activation");
			const session = await ctx.activate(license.key);
			await ctx.app.services.database
				.sql`UPDATE license_trials SET "activatedAt" = now() - interval '2 seconds', "expiresAt" = now() - interval '1 second' WHERE "licenseId" = ${license.id}`;
			await expect(
				ctx.app.services.sessions.heartbeat({
					token: session.token,
					deviceId: "test-device",
					ip: "127.0.0.1",
				}),
			).rejects.toMatchObject({ code: "LICENSE_EXPIRED" });
		});
		test("concurrent admissions cannot overrun registered device/IP limits", async () => {
			const license = await ctx.license();
			await ctx.app.services.access.policy(license.id, { maxSessions: 10 });
			const attempts = await Promise.allSettled(
				Array.from({ length: 12 }, (_, i) =>
					ctx.activate(license.key, `device-${i}`, `192.0.2.${i + 1}`),
				),
			);
			expect(
				attempts.filter((attempt) => attempt.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				(await ctx.app.services.access.devices(license.id, {})).items,
			).toHaveLength(1);
			expect(
				(await ctx.app.services.access.ips(license.id, {})).items,
			).toHaveLength(1);
		});
		test("atomic Redis admission enforces limits independently of PostgreSQL", async () => {
			const repository = new SessionRepository(ctx.app.services.redis);
			const licenseId = crypto.randomUUID();
			const record = {
				licenseId,
				deviceHash: digest("d"),
				ip: "127.0.0.1",
				revision: 1,
			};
			const ids = Array.from({ length: 20 }, () => digest(crypto.randomUUID()));
			const attempts = await Promise.allSettled(
				ids.map((id) => repository.admit(id, record, 5, 3)),
			);
			expect(
				attempts.filter((attempt) => attempt.status === "fulfilled"),
			).toHaveLength(3);
			await Promise.all(ids.map((id) => repository.remove(id, record)));
		});
		test("first-activation trial starts once and remains unchanged on repeated admission", async () => {
			const license = await ctx.license("trial");
			expect(license.trial?.activatedAt).toBeNull();
			await ctx.app.services.access.policy(license.id, { maxSessions: 10 });
			await Promise.all(
				Array.from({ length: 8 }, () => ctx.activate(license.key)),
			);
			const started = await ctx.app.services.licenses.get(license.id);
			expect(started.trial?.activatedAt).toBeInstanceOf(Date);
			expect(started.trial?.expiresAt?.getTime()).toBe(
				(started.trial?.activatedAt?.getTime() ?? 0) + 60000,
			);
			await ctx.app.services.sessions.terminateAll(license.id);
			await ctx.activate(license.key);
			expect(
				(await ctx.app.services.licenses.get(license.id)).trial?.activatedAt,
			).toEqual(started.trial?.activatedAt);
			await ctx.app.services.database.orm
				.update(trials)
				.set({
					activatedAt: new Date(Date.now() - 120000),
					expiresAt: new Date(Date.now() - 60000),
				})
				.where(eq(trials.licenseId, license.id));
			await expect(ctx.activate(license.key)).rejects.toMatchObject({
				code: "LICENSE_EXPIRED",
			});
		});
		test("database rollback compensates Redis and trial/registration changes", async () => {
			const license = await ctx.license("trial");
			const { database, redis, logger } = ctx.app.services;
			const records = new ActivityRepository(database.orm);
			const failure = spyOn(records, "write").mockImplementation(() => {
				throw new Error("forced audit failure");
			});
			const service = new SessionService(
				database,
				new SessionRepository(redis),
				new LicenseRepository(database),
				new LicensePolicy(),
				new AccessRepository(database.orm),
				records,
				60,
				logger,
				new SessionWorkQueue(),
			);
			await expect(
				service.activate({ key: license.key, deviceId: "d" }, "127.0.0.1"),
			).rejects.toThrow("forced audit failure");
			failure.mockRestore();
			expect(
				(await ctx.app.services.licenses.get(license.id)).trial?.activatedAt,
			).toBeNull();
			expect(
				(await ctx.app.services.access.devices(license.id, {})).items,
			).toHaveLength(0);
			expect(
				(await ctx.app.services.sessions.list({ licenseId: license.id })).items,
			).toHaveLength(0);
			await expect(ctx.activate(license.key, "d")).resolves.toBeDefined();
		});
		test("failed IP admission rolls back tentative device registration", async () => {
			const license = await ctx.license();
			await ctx.app.services.access.policy(license.id, {
				maxDevices: 5,
				maxSessions: 5,
			});
			await ctx.activate(license.key, "one", "192.0.2.1");
			await expect(
				ctx.activate(license.key, "two", "192.0.2.2"),
			).rejects.toMatchObject({ code: "IP_LIMIT" });
			expect(
				(await ctx.app.services.access.devices(license.id, {})).items,
			).toHaveLength(1);
		});
		test("sessions reject changed device, IP, revision, rotation, and termination", async () => {
			const license = await ctx.license();
			const session = await ctx.activate(license.key);
			const identity = {
				token: session.token,
				deviceId: "test-device",
				ip: "127.0.0.1",
			};
			await expect(
				ctx.app.services.sessions.heartbeat({ ...identity, ip: "192.0.2.10" }),
			).rejects.toMatchObject({ code: "SESSION_BINDING" });
			await ctx.app.services.access.block(license.id, "Manual block");
			await expect(
				ctx.app.services.sessions.heartbeat(identity),
			).rejects.toMatchObject({ code: "SESSION_STALE" });
			await expect(ctx.activate(license.key)).rejects.toMatchObject({
				code: "LICENSE_BLOCKED",
			});
			await ctx.app.services.access.block(license.id, null);
			const rotated = await ctx.app.services.licenses.rotate(license.id);
			await expect(ctx.activate(license.key)).rejects.toMatchObject({
				code: "LICENSE_INVALID",
			});
			const replacement = await ctx.activate(rotated.key);
			await ctx.app.services.sessions.terminate(
				license.id,
				digest(replacement.token),
			);
			await expect(
				ctx.app.services.sessions.heartbeat({
					...identity,
					token: replacement.token,
				}),
			).rejects.toMatchObject({ code: "SESSION_INVALID" });
		});
		test("revocation linearizes against runtime requests and frees old session slots", async () => {
			const license = await ctx.license();
			const initial = await ctx.activate(license.key);
			const identity = {
				token: initial.token,
				deviceId: "test-device",
				ip: "127.0.0.1",
			};
			await Promise.allSettled([
				ctx.app.services.sessions.heartbeat(identity),
				ctx.app.services.access.block(license.id, "blocked"),
			]);
			await expect(
				ctx.app.services.sessions.heartbeat(identity),
			).rejects.toMatchObject({ code: "SESSION_STALE" });
			await ctx.app.services.access.block(license.id, null);
			await expect(ctx.activate(license.key)).resolves.toBeDefined();
		});
		test("allowlists, registration blocking/removal, and type changes replace config", async () => {
			const license = await ctx.license("subscription");
			await ctx.app.services.access.allowlists(license.id, {
				devices: ["allowed"],
				networks: ["192.0.2.0/24"],
			});
			await ctx.app.services.access.policy(license.id, {
				deviceAllowlistEnabled: true,
				ipAllowlistEnabled: true,
			});
			await expect(
				ctx.activate(license.key, "denied", "192.0.2.1"),
			).rejects.toMatchObject({ code: "DEVICE_NOT_ALLOWED" });
			await expect(
				ctx.activate(license.key, "allowed", "198.51.100.1"),
			).rejects.toMatchObject({ code: "IP_NOT_ALLOWED" });
			await ctx.activate(license.key, "allowed", "192.0.2.1");
			const device = (await ctx.app.services.access.devices(license.id, {}))
				.items[0];
			if (!device) throw new Error("Missing registration");
			await ctx.app.services.access.registration(
				license.id,
				device.id,
				"device",
				true,
			);
			await expect(
				ctx.activate(license.key, "allowed", "192.0.2.1"),
			).rejects.toMatchObject({ code: "ACCESS_BLOCKED" });
			await ctx.app.services.access.registration(
				license.id,
				device.id,
				"device",
				null,
			);
			await ctx.app.services.licenses.changeType(license.id, {
				type: "trial",
				durationSeconds: 120,
			});
			expect(
				(await ctx.app.services.licenses.get(license.id)).subscription,
			).toBeNull();
			await ctx.app.services.licenses.changeType(license.id, {
				type: "lifetime",
			});
			expect(
				(await ctx.app.services.licenses.get(license.id)).trial,
			).toBeNull();
		});
		test("renewal requires increasing expiry and activity filters/stats/retention are redacted", async () => {
			const license = await ctx.license("subscription");
			await ctx.app.services.database.orm
				.update(subscriptions)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(subscriptions.licenseId, license.id));
			await expect(ctx.activate(license.key)).rejects.toMatchObject({
				code: "LICENSE_EXPIRED",
			});
			const expiry = new Date(Date.now() + 172800000).toISOString();
			await ctx.app.services.licenses.renew(license.id, expiry);
			await expect(
				ctx.app.services.licenses.renew(license.id, expiry),
			).rejects.toMatchObject({ code: "INVALID_EXPIRY" });
			await ctx.activate(license.key);
			const list = await ctx.app.services.activity.list({
				licenseId: license.id,
			});
			expect(list.items.length).toBeGreaterThan(0);
			expect(JSON.stringify(list)).not.toContain(license.key);
			expect(
				(
					await ctx.app.services.activity.stats({ licenseId: license.id })
				).items.some((row) => row.action === "session.activated"),
			).toBe(true);
			await ctx.app.services.database.orm.insert(activity).values({
				action: "old.event",
				createdAt: new Date(Date.now() - 31 * 86400000),
			});
			expect((await ctx.app.services.activity.prune()).deleted).toBe(1);
		});
	},
);
