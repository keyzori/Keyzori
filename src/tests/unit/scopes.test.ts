import { describe, expect, test } from "bun:test";
import { ScopeService } from "../../core/auth/ScopeService";
import { actions } from "../../core/auth/scopes";

describe("independent scope grants", () => {
	const service = new ScopeService();

	test("rejects root grants, unknown actions, duplicates and overlaps", () => {
		for (const grants of [
			["*:*"],
			["settings:read"],
			["api-keys:*"],
			["webhooks:rotate"],
			["licenses:read", "licenses:read"],
			["licenses:read", "licenses:*"],
		])
			expect(() => service.validate(grants)).toThrow();
	});

	test("expands wildcards to concrete grants and fails closed for stored wildcards", () => {
		const grants = service.validate(["licenses:read", "users:*"]);
		expect(grants).toEqual([
			"licenses:read",
			...actions.filter((action) => action.startsWith("users:")),
		]);
		expect(service.validStored(grants)).toBe(true);
		expect(service.allows(grants, "users:delete")).toBe(true);
		expect(service.allows(grants, "licenses:rotate")).toBe(false);
		expect(service.allows(grants, "users:new-action")).toBe(false);
		expect(service.allows(["users:*"], "users:read")).toBe(false);
		expect(service.allows(["users:read", "unknown:read"], "users:read")).toBe(
			false,
		);
	});

	test("empty grants authorize nothing and families cannot grant operator access", () => {
		for (const action of actions)
			expect(service.allows([], action)).toBe(false);
		for (const operation of [
			"root",
			"api-keys:create",
			"settings:update",
			"metrics:read",
		])
			expect(service.allows(actions, operation)).toBe(false);
		expect(
			service.allows(service.validate(["usage:*"]), "licenses:update"),
		).toBe(false);
		expect(
			service.allows(service.validate(["groups:*"]), "licenses:delete"),
		).toBe(false);
	});
});
