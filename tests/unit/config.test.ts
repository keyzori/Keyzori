import { describe, expect, test } from "bun:test";
import { Config } from "../../src/shared/Config.ts";
import { StripeConfig } from "../../plugins/stripe/StripeConfig.ts";

const base = {
	KEYZORI_ADMIN_KEY: "test-only-admin-key-at-least-32-characters",
	KEYZORI_DATABASE_URL: "postgresql://localhost/test",
	KEYZORI_REDIS_URL: "redis://localhost",
};
describe("configuration boundaries", () => {
	for (const [name, min, max] of [
		["KEYZORI_PORT", 0, 65535],
		["KEYZORI_SESSION_TTL", 5, 3600],
		["KEYZORI_ACTIVITY_RETENTION_DAYS", 1, 3650],
		["KEYZORI_RATE_LIMIT", 1, 100000],
	] as const) {
		test.each([String(min), String(max)])(
			`${name} accepts boundary %s`,
			(value) => {
				expect(() => new Config({ ...base, [name]: value })).not.toThrow();
			},
		);
		test.each([
			"",
			"-1",
			"1.5",
			"NaN",
			"Infinity",
			"1e2",
			" 5",
			"5 ",
			String(max + 1),
			"9007199254740992",
		])(`${name} rejects %s`, (value) =>
			expect(() => new Config({ ...base, [name]: value })).toThrow(name),
		);
	}
	test.each(["KEYZORI_ADMIN_KEY", "KEYZORI_DATABASE_URL", "KEYZORI_REDIS_URL"])(
		"requires %s",
		(name) => {
			for (const value of [undefined, "", " "])
				expect(() => new Config({ ...base, [name]: value })).toThrow(name);
		},
	);
	test.each([
		"short",
		"replace_with_at_least_32_random_characters",
		"change_this_admin_password_xxxxxxx",
		"YOUR_SECURE_ADMIN_KEY_xxxxxxxxxxxx",
		"example-admin-key-at-least-32-characters",
		"development-admin-key-at-least-32-characters",
	])("rejects weak admin key %s", (value) =>
		expect(() => new Config({ ...base, KEYZORI_ADMIN_KEY: value })).toThrow(
			"KEYZORI_ADMIN_KEY",
		),
	);
	test.each(["http://user:private@localhost", "not-a-url"])(
		"rejects database URL %s without exposing credentials",
		(value) => {
			try {
				new Config({ ...base, KEYZORI_DATABASE_URL: value });
				throw new Error("accepted invalid URL");
			} catch (error) {
				expect(String(error)).toContain(
					"KEYZORI_DATABASE_URL has an invalid URL",
				);
				expect(String(error)).not.toContain("private");
			}
		},
	);
	test("accepts supported database and TLS Redis schemes", () => {
		expect(
			() =>
				new Config({
					...base,
					KEYZORI_DATABASE_URL: "postgres://localhost/db",
					KEYZORI_REDIS_URL: "rediss://localhost",
				}),
		).not.toThrow();
		expect(
			() => new Config({ ...base, KEYZORI_REDIS_URL: "https://localhost" }),
		).toThrow("invalid URL");
	});
	test("plugin names are normalized, sorted, and bounded", () => {
		expect(
			new Config({ ...base, KEYZORI_PLUGINS: " z, a,, " }).plugins,
		).toEqual(["a", "z"]);
		expect(
			new Config({ ...base, KEYZORI_PLUGINS: "a".repeat(64) }).plugins,
		).toHaveLength(1);
		for (const value of ["a,a", "A", "../stripe", "a/b", "a_b", "a".repeat(65)])
			expect(() => new Config({ ...base, KEYZORI_PLUGINS: value })).toThrow(
				"invalid names",
			);
	});
	test.each([
		"192.0.2.0/33",
		"::1/129",
		"192.0.2.1/-1",
		"192.0.2.1/1/2",
		"::1/no",
		"fe80::1%eth0",
		"invalid",
	])("rejects malformed trusted proxy %s", (value) =>
		expect(
			() => new Config({ ...base, KEYZORI_TRUSTED_PROXIES: value }),
		).toThrow("proxy"),
	);
	test("accepts IPv4 and IPv6 proxy networks including exact hosts", () => {
		const config = new Config({
			...base,
			KEYZORI_TRUSTED_PROXIES: "192.0.2.0/24, ::1, 2001:db8::/32",
		});
		expect(config.trustedProxies.check("192.0.2.255", "ipv4")).toBe(true);
		expect(config.trustedProxies.check("192.0.3.1", "ipv4")).toBe(false);
		expect(config.trustedProxies.check("2001:db8::1234", "ipv6")).toBe(true);
	});
});
describe("Stripe configuration", () => {
	test.each(["sk_test_fake", "rk_test_fake", "sk_live_fake", "rk_live_fake"])(
		"accepts key format %s",
		(key) => {
			expect(
				new StripeConfig({
					KEYZORI_STRIPE_SECRET_KEY: key,
					KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_fake",
				}).secretKey,
			).toBe(key);
		},
	);
	test.each(["", "pk_test_fake", "sk_test_", "sk_test_fake!"])(
		"rejects key format %s",
		(key) => {
			expect(
				() =>
					new StripeConfig({
						KEYZORI_STRIPE_SECRET_KEY: key,
						KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_fake",
					}),
			).toThrow("SECRET_KEY");
		},
	);
	test.each(["", "whsec_", "secret", "whsec_fake!"])(
		"rejects webhook secret %s",
		(key) => {
			expect(
				() =>
					new StripeConfig({
						KEYZORI_STRIPE_SECRET_KEY: "sk_test_fake",
						KEYZORI_STRIPE_WEBHOOK_SECRET: key,
					}),
			).toThrow("WEBHOOK_SECRET");
		},
	);
});
