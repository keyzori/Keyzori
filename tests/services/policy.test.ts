import { describe, expect, test } from "bun:test";
import { Config } from "../../src/shared/Config.ts";
import { ClientIp, normalizeIp } from "../../src/shared/ClientIp.ts";
import {
	digest,
	equalSecret,
	metadata,
	redact,
} from "../../src/shared/security.ts";
import { activationBody } from "../../src/sessions/schemas.ts";
import { licenseBody, licenseConfig } from "../../src/licenses/schemas.ts";
import { activityQuery } from "../../src/activity/schemas.ts";
import { pagination } from "../../src/shared/schemas.ts";
import { LicensePolicy } from "../../src/licenses/LicensePolicy.ts";

const env = {
	KEYZORI_ADMIN_KEY: "valid-admin-key-at-least-32-characters",
	KEYZORI_DATABASE_URL: "postgresql://localhost/test",
	KEYZORI_REDIS_URL: "redis://localhost",
};
describe("configuration and validation", () => {
	test("mandatory secret, strict numbers, plugins, and defaults", () => {
		expect(() => new Config({ ...env, KEYZORI_ADMIN_KEY: "short" })).toThrow();
		expect(() => new Config({ ...env, KEYZORI_PORT: "3.5" })).toThrow();
		expect(() => new Config({ ...env, KEYZORI_PLUGINS: "a,a" })).toThrow();
		expect(
			() => new Config({ ...env, KEYZORI_PLUGINS: "../stripe" }),
		).toThrow();
		const config = new Config(env);
		expect(config.plugins).toEqual([]);
		expect(config.sessionTtl).toBe(60);
		expect(config.retentionDays).toBe(30);
	});
	test("bodies reject unknown fields and incompatible license configurations", () => {
		expect(
			licenseConfig.allows({ type: "lifetime", expiresAt: "2028-01-01" }),
		).toBe(false);
		expect(licenseConfig.allows({ type: "trial", durationSeconds: 0 })).toBe(
			false,
		);
		expect(
			licenseBody.allows({
				customerId: crypto.randomUUID(),
				config: { type: "lifetime" },
				surprise: true,
			}),
		).toBe(false);
		expect(
			activationBody.allows({
				key: `lic_${"a".repeat(43)}`,
				deviceId: "d",
				extra: true,
			}),
		).toBe(false);
		expect(
			activityQuery.allows({
				licenseId: crypto.randomUUID(),
				action: "session.heartbeat",
				limit: "10",
			}),
		).toBe(true);
		expect(() => pagination({ limit: "101" })).toThrow();
		expect(() => pagination({ offset: "9007199254740992" })).toThrow();
	});
	test("redaction, bounded metadata, and fixed-size credential comparison", () => {
		expect(equalSecret("same", "same")).toBe(true);
		expect(equalSecret("", "same")).toBe(false);
		expect(digest("key")).toHaveLength(64);
		expect(
			redact({ nested: { password: "hidden" }, message: "lic_abcd" }),
		).toEqual({ nested: { password: "[REDACTED]" }, message: "[REDACTED]" });
		expect(() => metadata({ note: "x".repeat(8193) })).toThrow();
	});
	test("IP normalization and explicit proxy trust", () => {
		expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
		expect(normalizeIp("2001:0db8::1")).toBe("2001:db8::1");
		const request = new Request("http://test", {
			headers: { "x-forwarded-for": "1.1.1.1, 10.1.1.1" },
		});
		expect(new ClientIp(new Config(env)).resolve(request, "127.0.0.1")).toBe(
			"127.0.0.1",
		);
		const resolver = new ClientIp(
			new Config({
				...env,
				KEYZORI_TRUSTED_PROXIES: "127.0.0.1/32,10.0.0.0/8",
			}),
		);
		expect(resolver.resolve(request, "127.0.0.1")).toBe("1.1.1.1");
		expect(() => resolver.resolve(request, undefined)).toThrow();
		expect(() => normalizeIp("fe80::1%eth0")).toThrow();
		for (const proxy of ["127.0.0.1/", "10.0.0.0/8/0", "127.0.0.1/0x20"])
			expect(
				() => new Config({ ...env, KEYZORI_TRUSTED_PROXIES: proxy }),
			).toThrow();
	});
	test("subscription configuration cannot start expired", () => {
		expect(() =>
			new LicensePolicy().validateConfig({
				type: "subscription",
				expiresAt: "2000-01-01T00:00:00Z",
			}),
		).toThrow();
	});
});
