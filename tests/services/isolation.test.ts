import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { digest } from "../../src/shared/security.ts";

describe.skipIf(!integrationAvailable)(
	"resource isolation and atomic updates",
	() => {
		let ctx: TestContext;
		beforeAll(async () => {
			ctx = await new TestContext().start();
		});
		afterAll(async () => {
			await ctx?.close();
		});
		test("keys are hashed in storage and excluded from all read models", async () => {
			const license = await ctx.license();
			const [stored] = await ctx.app.services.database
				.sql`SELECT "keyHash" FROM licenses WHERE id = ${license.id}`;
			expect(stored.keyHash).toBe(digest(license.key));
			for (const value of [
				await ctx.app.services.licenses.get(license.id),
				await ctx.app.services.licenses.list({
					customerId: license.customerId,
				}),
				await ctx.app.services.access.get(license.id),
			]) {
				expect(JSON.stringify(value)).not.toContain(license.key);
				expect(JSON.stringify(value)).not.toContain(stored.keyHash);
			}
		});
		test("customer deletion respects references and failed updates preserve existing data", async () => {
			const license = await ctx.license();
			const customer = await ctx.app.services.customers.get(license.customerId);
			await expect(
				ctx.app.services.customers.delete(customer.id),
			).rejects.toThrow();
			expect(await ctx.app.services.customers.get(customer.id)).toEqual(
				customer,
			);
			const other = await ctx.customer();
			await expect(
				ctx.app.services.customers.update(customer.id, {
					email: other.email,
					name: "Changed",
				}),
			).rejects.toThrow();
			expect(await ctx.app.services.customers.get(customer.id)).toEqual(
				customer,
			);
			const before = await ctx.app.services.licenses.get(license.id);
			await expect(
				ctx.app.services.licenses.update(license.id, {
					customerId: crypto.randomUUID(),
				}),
			).rejects.toThrow();
			expect(await ctx.app.services.licenses.get(license.id)).toEqual(before);
		});
		test("license pages filter by owner/type with stable offsets and lookahead", async () => {
			const customer = await ctx.customer();
			for (const type of ["lifetime", "metered", "lifetime"] as const)
				await ctx.app.services.licenses.create({
					customerId: customer.id,
					config: { type },
				});
			const first = await ctx.app.services.licenses.list({
				customerId: customer.id,
				limit: "2",
			});
			const last = await ctx.app.services.licenses.list({
				customerId: customer.id,
				limit: "2",
				offset: "2",
			});
			expect(first.items).toHaveLength(2);
			expect(first.hasMore).toBe(true);
			expect(last.items).toHaveLength(1);
			expect(last.hasMore).toBe(false);
			expect(
				new Set([...first.items, ...last.items].map((row) => row.id)).size,
			).toBe(3);
			const filtered = await ctx.app.services.licenses.list({
				customerId: customer.id,
				type: "metered",
			});
			expect(filtered.items).toHaveLength(1);
			expect(filtered.items[0]?.type).toBe("metered");
		});
		test("cross-license registration and session mutations fail without affecting the owner", async () => {
			const owner = await ctx.license();
			const other = await ctx.license();
			const session = await ctx.activate(owner.key);
			const device = (await ctx.app.services.access.devices(owner.id, {}))
				.items[0];
			const ip = (await ctx.app.services.access.ips(owner.id, {})).items[0];
			if (!device || !ip) throw new Error("Missing registrations");
			await expect(
				ctx.app.services.access.registration(
					other.id,
					device.id,
					"device",
					true,
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				ctx.app.services.access.registration(other.id, ip.id, "ip", null),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				ctx.app.services.sessions.terminate(other.id, digest(session.token)),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				ctx.app.services.sessions.heartbeat({
					token: session.token,
					deviceId: "test-device",
					ip: "127.0.0.1",
				}),
			).resolves.toBeDefined();
			expect(
				(await ctx.app.services.access.devices(owner.id, {})).items[0]?.blocked,
			).toBe(false);
		});
		test("allowlist replacement deduplicates and failed validation preserves policy", async () => {
			const license = await ctx.license();
			await ctx.app.services.access.allowlists(license.id, {
				devices: ["device", "device"],
				networks: ["192.0.2.0/24", "192.0.2.0/24"],
			});
			const before = await ctx.app.services.access.get(license.id);
			expect(before.allowlists.devices).toHaveLength(1);
			expect(before.allowlists.networks).toHaveLength(1);
			for (const networks of [
				["192.0.2.0/33"],
				["::1/129"],
				["invalid"],
				["192.0.2.1/1/2"],
			])
				await expect(
					ctx.app.services.access.allowlists(license.id, {
						devices: ["replacement"],
						networks,
					}),
				).rejects.toThrow();
			await expect(
				ctx.app.services.access.allowlists(license.id, {
					devices: [" "],
					networks: [],
				}),
			).rejects.toMatchObject({ code: "INVALID_DEVICE" });
			expect(await ctx.app.services.access.get(license.id)).toEqual(before);
		});
		test("IPv6 allowlists honor boundaries and mapped IPv4 uses one registration", async () => {
			const license = await ctx.license();
			await ctx.app.services.access.allowlists(license.id, {
				devices: [],
				networks: ["2001:db8::/32"],
			});
			await ctx.app.services.access.policy(license.id, {
				ipAllowlistEnabled: true,
			});
			await expect(
				ctx.activate(license.key, "d", "2001:db9::1"),
			).rejects.toMatchObject({ code: "IP_NOT_ALLOWED" });
			await ctx.activate(license.key, "d", "2001:db8::1");
			const mapped = await ctx.license();
			await ctx.app.services.access.policy(mapped.id, { maxSessions: 2 });
			await ctx.activate(mapped.key, "d", "::ffff:192.0.2.1");
			await ctx.activate(mapped.key, "d", "192.0.2.1");
			expect(
				(await ctx.app.services.access.ips(mapped.id, {})).items,
			).toHaveLength(1);
		});
		test("source blocks remain independent through recovery and reject invalid source names", async () => {
			const license = await ctx.license();
			const { database, access } = ctx.app.services;
			await database.orm.transaction((tx) =>
				access.setBlock(tx, license.id, "billing", "overdue"),
			);
			await access.block(license.id, "manual");
			await database.orm.transaction((tx) =>
				access.setBlock(tx, license.id, "billing", null),
			);
			expect(
				(await ctx.app.services.licenses.get(license.id)).blocks.map(
					(row) => row.source,
				),
			).toEqual(["manual"]);
			await expect(
				database.orm.transaction((tx) =>
					access.setBlock(tx, license.id, "../bad", "blocked"),
				),
			).rejects.toMatchObject({ code: "INVALID_SOURCE" });
			await expect(ctx.activate(license.key)).rejects.toMatchObject({
				code: "LICENSE_BLOCKED",
			});
			await access.block(license.id, null);
			await expect(ctx.activate(license.key)).resolves.toBeDefined();
		});
		test("usage receipts survive type changes and event IDs remain scoped to each license", async () => {
			const first = await ctx.license("metered");
			const second = await ctx.license("metered");
			const consume = async (license: typeof first, units: number) => {
				const session = await ctx.activate(license.key);
				return ctx.app.services.sessions.withSession(
					{ token: session.token, deviceId: "test-device", ip: "127.0.0.1" },
					(tx, row) =>
						ctx.app.services.meters.consume(tx, row, {
							meter: "exports",
							units,
							eventId: "same-id",
						}),
				);
			};
			const meter = await ctx.app.services.meters.create({
				licenseId: first.id,
				name: "exports",
				limit: 10,
			});
			await ctx.app.services.meters.create({
				licenseId: second.id,
				name: "exports",
				limit: 10,
			});
			const receipt = await consume(first, 3);
			expect((await consume(second, 5)).used).toBe(5);
			await ctx.app.services.licenses.changeType(first.id, {
				type: "lifetime",
			});
			await expect(
				ctx.app.services.meters.update(meter.id, 20),
			).rejects.toMatchObject({ code: "INVALID_TYPE" });
			await ctx.app.services.licenses.changeType(first.id, { type: "metered" });
			expect((await ctx.app.services.meters.get(meter.id)).used).toBe(0);
			expect(await consume(first, 3)).toEqual(receipt);
			expect((await ctx.app.services.meters.get(meter.id)).used).toBe(0);
			expect(
				(await ctx.app.services.meters.usage({ licenseId: first.id })).items,
			).toHaveLength(1);
		});
		test("non-subscription renewal and non-metered meter creation fail without changing policy", async () => {
			const license = await ctx.license();
			const before = await ctx.app.services.licenses.get(license.id);
			await expect(
				ctx.app.services.licenses.renew(
					license.id,
					new Date(Date.now() + 86400000).toISOString(),
				),
			).rejects.toMatchObject({ code: "INVALID_TYPE" });
			await expect(
				ctx.app.services.meters.create({
					licenseId: license.id,
					name: "exports",
					limit: 10,
				}),
			).rejects.toMatchObject({ code: "INVALID_TYPE" });
			expect(await ctx.app.services.licenses.get(license.id)).toEqual(before);
		});
	},
);
