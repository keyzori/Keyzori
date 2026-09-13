import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";

describe.skipIf(!integrationAvailable)("meter list filters", () => {
	let ctx: TestContext;
	beforeAll(async () => {
		ctx = await new TestContext().start();
	});
	afterAll(async () => {
		await ctx?.close();
	});
	test("meterId filters before pagination and cannot cross license boundaries", async () => {
		const license = await ctx.license("metered");
		const other = await ctx.license("metered");
		const first = await ctx.app.services.meters.create({
			licenseId: license.id,
			name: "first",
			limit: 10,
		});
		await ctx.app.services.meters.create({
			licenseId: license.id,
			name: "second",
			limit: 10,
		});
		const query = `/admin/meters?licenseId=${license.id}&meterId=${first.id}`;
		const filtered = await ctx.request(`${query}&limit=1`);
		expect(filtered.status).toBe(200);
		expect(filtered.body.items).toHaveLength(1);
		expect(filtered.body.items[0].id).toBe(first.id);
		expect(filtered.body.hasMore).toBe(false);
		expect((await ctx.request(`${query}&offset=1`)).body.items).toHaveLength(0);
		expect(
			(
				await ctx.request(
					`/admin/meters?licenseId=${other.id}&meterId=${first.id}`,
				)
			).body.items,
		).toHaveLength(0);
		expect(
			(await ctx.request(`/admin/meters?licenseId=${license.id}`)).body.items,
		).toHaveLength(2);
	});
});
