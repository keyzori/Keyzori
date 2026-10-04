import { describe, expect, test } from "bun:test";
import { TypeBoxValidator } from "elysia";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import { licenses } from "../../core/database/schema/licenses";
import { settingsModel } from "../../plugins/settings/model";

describe("default pagination boundaries", () => {
	const validator = new TypeBoxValidator(settingsModel.changes);

	test("every boundary admitted by settings works as a default and an explicit limit", () => {
		for (const limit of [1, 10, 2147483645, 2147483646]) {
			expect(validator.Check({ defaultPageLimit: limit })).toBe(true);
			expect(
				new ResourceQuery(new URLSearchParams(), licenses, limit).limit,
			).toBe(limit);
			expect(
				new ResourceQuery(
					new URLSearchParams({ limit: String(limit) }),
					licenses,
				).limit,
			).toBe(limit);
		}
		expect(validator.Check({})).toBe(true);
		expect(new ResourceQuery(new URLSearchParams(), licenses).limit).toBe(10);
	});

	test("rejects zero, negative, fractional, overflowing and mistyped settings", () => {
		for (const limit of [
			0,
			-1,
			1.5,
			2147483647,
			2147483648,
			Number.MAX_SAFE_INTEGER,
			Infinity,
			NaN,
		]) {
			expect(validator.Check({ defaultPageLimit: limit })).toBe(false);
			expect(
				() => new ResourceQuery(new URLSearchParams(), licenses, limit),
			).toThrow();
		}
		for (const limit of [null, "10", true]) {
			const input = { defaultPageLimit: limit } as unknown as Parameters<
				typeof validator.Check
			>[0];
			expect(validator.Check(input)).toBe(false);
		}
		for (const limit of [
			"",
			"0",
			"-1",
			"1.5",
			"01",
			"1e2",
			"2147483647",
			"9007199254740992",
		])
			expect(
				() => new ResourceQuery(new URLSearchParams({ limit }), licenses),
			).toThrow();
	});
});
