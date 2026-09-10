import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { ActivityRepository } from "../../src/activity/ActivityRepository.ts";
import { LicenseRepository } from "../../src/licenses/LicenseRepository.ts";
import { MeterRepository } from "../../src/meters/MeterRepository.ts";
import { MeterService } from "../../src/meters/MeterService.ts";

describe.skipIf(!integrationAvailable)("transactional metering", () => {
	let ctx: TestContext;
	beforeAll(async () => {
		ctx = await new TestContext().start();
	});
	afterAll(async () => {
		await ctx?.close();
	});
	async function fixture() {
		const license = await ctx.license("metered");
		const meter = await ctx.app.services.meters.create({
			licenseId: license.id,
			name: "exports",
			limit: 10,
		});
		const session = await ctx.activate(license.key);
		const identity = {
			token: session.token,
			deviceId: "test-device",
			ip: "127.0.0.1",
		};
		const consume = (eventId: string, units: number, name = "exports") =>
			ctx.app.services.sessions.withSession(identity, (tx, row) =>
				ctx.app.services.meters.consume(tx, row, {
					meter: name,
					eventId,
					units,
				}),
			);
		return { license, meter, identity, consume };
	}
	test("identical concurrent retries return the original result exactly once", async () => {
		const { license, meter, consume } = await fixture();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => consume("one-event", 3)),
		);
		for (const result of results) expect(result).toEqual(results[0] ?? result);
		expect((await ctx.app.services.meters.get(meter.id)).used).toBe(3);
		expect(
			(await ctx.app.services.meters.usage({ licenseId: license.id })).items,
		).toHaveLength(1);
		await expect(consume("one-event", 4)).rejects.toMatchObject({
			code: "EVENT_CONFLICT",
		});
		await ctx.app.services.meters.create({
			licenseId: license.id,
			name: "other",
			limit: 20,
		});
		await expect(consume("one-event", 3, "other")).rejects.toMatchObject({
			code: "EVENT_CONFLICT",
		});
	});
	test("racing different events never spend below zero", async () => {
		const { meter, consume } = await fixture();
		const attempts = await Promise.allSettled(
			Array.from({ length: 10 }, (_, i) => consume(`event-${i}`, 3)),
		);
		expect(
			attempts.filter((attempt) => attempt.status === "fulfilled"),
		).toHaveLength(3);
		expect((await ctx.app.services.meters.get(meter.id)).used).toBe(9);
		await expect(
			ctx.app.services.meters.update(meter.id, 8),
		).rejects.toMatchObject({ code: "INVALID_LIMIT" });
		await expect(consume("negative", -1)).rejects.toMatchObject({
			code: "INVALID_UNITS",
		});
	});
	test("audit failure rolls back ledger and balance, allowing a safe retry", async () => {
		const { meter, identity, consume } = await fixture();
		const database = ctx.app.services.database;
		const audit = new ActivityRepository(database.orm);
		const failure = spyOn(audit, "write").mockImplementation(() => {
			throw new Error("audit failed");
		});
		const service = new MeterService(
			database,
			new MeterRepository(database.orm),
			new LicenseRepository(database),
			audit,
		);
		await expect(
			ctx.app.services.sessions.withSession(identity, (tx, license) =>
				service.consume(tx, license, {
					meter: "exports",
					units: 5,
					eventId: "retry",
				}),
			),
		).rejects.toThrow("audit failed");
		failure.mockRestore();
		expect((await ctx.app.services.meters.get(meter.id)).used).toBe(0);
		expect((await consume("retry", 5)).remaining).toBe(5);
	});
});
