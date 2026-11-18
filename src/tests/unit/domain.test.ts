import { describe, expect, test } from "bun:test";
import { Elysia, TypeBoxValidator } from "elysia";
import { DecimalPolicy } from "../../plugins/licenses/DecimalPolicy";
import { validationModel } from "../../plugins/validate/model";
import { meterModel } from "../../plugins/licenses/meterModel";
import { Decision } from "../../plugins/validate/Decision";
import { licenseModel } from "../../plugins/licenses/model";

const decimal = new DecimalPolicy();

describe("exact usage inputs", () => {
	test("canonicalizes trailing zeroes without binary arithmetic", () => {
		expect(decimal.value("999999999999999", 0)).toBe("999999999999999");
		expect(decimal.value("999999999.999999", 6)).toBe("999999999.999999");
		expect(decimal.value("0.100000", 1, true)).toBe("0.1");
		expect(decimal.value("12.000", 0)).toBe("12");
	});
	test.each([
		"-1",
		"+1",
		"1e3",
		"NaN",
		"Infinity",
		"01",
		"1.",
		".1",
		" 1",
		"1000000000000000",
	])("rejects invalid decimal %s", (input) => {
		expect(() => decimal.value(input, 0)).toThrow();
	});
	test("enforces configured scale, range and positive consumption", () => {
		expect(() => decimal.value("0.01", 1)).toThrow();
		expect(() => decimal.value("1000000000", 6)).toThrow();
		expect(() => decimal.value("0.000", 6, true)).toThrow();
		expect(decimal.value("0", 0)).toBe("0");
	});
});

test("validation supports exact nullable expected groups and excludes consumption", () => {
	const validator = new TypeBoxValidator(validationModel.body);
	expect(validator.Check({ license: "secret" })).toBe(true);
	expect(validator.Check({ license: "secret", expectedGroupId: null })).toBe(
		true,
	);
	expect(
		validator.Check({
			license: "secret",
			expectedGroupId: "019a3f4a-7bf4-7000-8000-000000000001",
		}),
	).toBe(true);
	expect(
		validator.Errors({ license: "secret", usage: { requests: "1" } }).length,
	).toBeGreaterThan(0);
});

test("counter definitions allow unlimited and no-reset without an overage bypass", () => {
	const validator = new TypeBoxValidator(meterModel.definition);
	expect(validator.Check({ name: "requests" })).toBe(true);
	expect(
		validator.Check({ name: "requests", limit: null, schedule: null }),
	).toBe(true);
	expect(validator.Check({ name: "requests", limit: "0" })).toBe(true);
	expect(
		validator.Errors({ name: "requests", limit: 3 }).length,
	).toBeGreaterThan(0);
	expect(
		validator.Errors({ name: "requests", allowOverage: true }).length,
	).toBeGreaterThan(0);
});

test("HTTP decoding never supplies a destructive meter action or overwrites omitted definition policy", async () => {
	const app = new Elysia({ normalize: false })
		.post("/adjust", { body: licenseModel.adjust }, ({ body }) => body)
		.post("/definition", { body: meterModel.definition }, ({ body }) => body);
	const post = (path: string, body: unknown) =>
		app.handle(
			new Request(`http://localhost${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	expect(
		(
			await post("/adjust", {
				ids: [Bun.randomUUIDv7()],
				name: "credits",
				value: "2",
			})
		).status,
	).toBeGreaterThanOrEqual(400);
	expect(
		(
			await post("/definition", {
				name: "credits",
				schedule: { time: "00:00" },
			})
		).status,
	).toBeGreaterThanOrEqual(400);
	const partial = { name: "credits", limit: "15" };
	const result = await post("/definition", partial);
	expect(result.status).toBe(200);
	expect(await result.json()).toEqual(partial);
});

test("disabled decisions expose the custom reason with a stable code", () => {
	expect(
		new Decision(
			"LICENSE_DISABLED",
			"Temporarily suspended by owner",
		).response(),
	).toEqual({
		code: "LICENSE_DISABLED",
		reason: "Temporarily suspended by owner",
	});
	expect(new Decision("LICENSE_DISABLED", null).response().reason).toBe(
		"License is disabled",
	);
});
