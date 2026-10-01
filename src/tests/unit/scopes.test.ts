import { describe, expect, test } from "bun:test";
import { ScopeService } from "../../core/auth/ScopeService";
import { scopes } from "../../core/auth/scopes";

describe("independent scope grants", () => {
	const service = new ScopeService();

	test("rejects hierarchy, root grants, obsolete actions, duplicates and overlaps", () => {
		for (const grants of [
			["*:*"],
			["settings:read"],
			["api-keys:*"],
			["webhooks:rotate"],
			["licenses:read", "licenses:read"],
			["licenses:read", "licenses:*"],
		]) {
			expect(() => service.validate(grants)).toThrow();
		}
		expect(
			service.validate(["licenses:read", "licenses:update", "users:*"]),
		).toEqual(["licenses:read", "licenses:update", "users:*"]);
	});

	test("family wildcards cannot authorize root-only or other-family operations", () => {
		const all = ["licenses:*", "users:*", "items:*", "webhooks:*"];
		for (const operation of [
			"settings:update",
			"api-keys:create",
			"audits:read",
			"metrics:read",
		]) {
			expect(service.allows(all, operation)).toBe(false);
			expect(() => service.authorize(all, operation)).toThrow();
			expect(() => service.authorize([], operation, true)).not.toThrow();
		}
		expect(service.allows(["licenses:read"], "licenses:rotate")).toBe(false);
		expect(service.allows(["users:*"], "items:delete")).toBe(false);
		for (const scope of scopes) expect(service.allows(all, scope)).toBe(true);
	});
});
