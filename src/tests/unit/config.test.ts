import { describe, expect, test } from "bun:test";
import { Config } from "../../core/config/Config";
import { KeyGenerator } from "../../core/security/KeyGenerator";

describe("environment configuration", () => {
	const environment = {
		KZ_DATABASE_URL: "postgresql://localhost/keyzori_test",
		KZ_REDIS_URL: "redis://localhost:6379/0",
		KZ_MASTER_KEY: new KeyGenerator().master(),
	};

	test("requires external dependencies and root while supplying operational defaults", () => {
		const config = new Config(environment);
		expect(config.host).toBe("0.0.0.0");
		expect(config.port).toBe(6284);
		expect(config.poolSize).toBe(10);
		expect(config.logLevel).toBe("info");
		expect(config.trustedProxies).toEqual([]);
		expect(config.clientIpHeaders).toEqual([]);
		expect(() => new Config({})).toThrow("KZ_DATABASE_URL");
		expect(() => new Config({ ...environment, KZ_MASTER_KEY: "" })).toThrow(
			"KZ_MASTER_KEY",
		);
	});

	test("validates explicit proxy networks and supported header order", () => {
		const config = new Config({
			...environment,
			KZ_TRUSTED_PROXIES: "127.0.0.1, 10.0.0.0/8,2001:db8::/32",
			KZ_CLIENT_IP_HEADERS: "CF-Connecting-IP, X-Forwarded-For",
		});
		expect(config.trustedProxies).toEqual([
			"127.0.0.1",
			"10.0.0.0/8",
			"2001:db8::/32",
		]);
		expect(config.clientIpHeaders).toEqual([
			"cf-connecting-ip",
			"x-forwarded-for",
		]);
		for (const invalid of [
			"10.0.0.0/33",
			"::/129",
			"127.0.0.1/",
			"10.0.0.0/8/2",
			"10.0.0.1,,10.0.0.2",
		]) {
			expect(
				() => new Config({ ...environment, KZ_TRUSTED_PROXIES: invalid }),
			).toThrow();
		}
		expect(
			() =>
				new Config({ ...environment, KZ_CLIENT_IP_HEADERS: "authorization" }),
		).toThrow("unsupported");
	});

	test.each(["127.0.0.1", "127.0.0.2", "::", "::1"])(
		"preserves the configured listener address %s",
		(host) =>
			expect(new Config({ ...environment, KZ_API_HOST: host }).host).toBe(host),
	);

	test.each(["", "localhost", "127.0.0.1:6284", "fe80::1%eth0"])(
		"rejects invalid listener address %s",
		(host) =>
			expect(() => new Config({ ...environment, KZ_API_HOST: host })).toThrow(
				"KZ_API_HOST",
			),
	);

	test("rejects malformed configuration without echoing secret values", () => {
		for (const value of ["0", "01", "6284junk", "65536", "1.5", ""]) {
			expect(() => new Config({ ...environment, KZ_API_PORT: value })).toThrow(
				"KZ_API_PORT",
			);
		}
		expect(
			() => new Config({ ...environment, KZ_LOG_LEVEL: "verbose" }),
		).toThrow("KZ_LOG_LEVEL");
		const secret = "sensitive-value";
		try {
			new Config({
				...environment,
				KZ_DATABASE_URL: `https://user:${secret}@localhost/db`,
			});
			throw new Error("Expected invalid URL rejection");
		} catch (error) {
			expect(String(error)).toContain("KZ_DATABASE_URL");
			expect(String(error)).not.toContain(secret);
		}
	});
});
