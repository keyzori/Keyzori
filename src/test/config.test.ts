import { describe, expect, test } from "bun:test";
import { loadServerConfig } from "../config";

const validEnvironment = {
	KEYZORI_DATABASE_URL: "postgresql://localhost/keyzori",
	KEYZORI_REDIS_URL: "redis://localhost:6379",
	KEYZORI_ADMIN_PASS: "admin-password",
	KEYZORI_TRUSTED_PROXY_HEADER: "x-forwarded-for",
};

describe("loadServerConfig", () => {
	test("loads secure defaults", () => {
		expect(loadServerConfig(validEnvironment)).toMatchObject({
			host: "0.0.0.0",
			port: 3000,
			trustProxyHeaders: false,
			trustedProxyHeader: "x-forwarded-for",
			openapiEnabled: true,
			rateLimitPerMinute: 60,
			licenseRateLimitPerMinute: 30,
			rateLimitPerIpPerMinute: 6_000,
			maxRequestBodyBytes: 65_536,
			trustedProxyCidrs: [],
			stripe: null,
			eventRetentionDays: 30,
		});
	});

	test("uses only prefixed host and port variables", () => {
		expect(
			loadServerConfig({
				...validEnvironment,
				HOST: "legacy-host",
				PORT: "3999",
			}),
		).toMatchObject({
			host: "0.0.0.0",
			port: 3000,
		});
		expect(
			loadServerConfig({
				...validEnvironment,
				KEYZORI_SERVER_HOST: "server-host",
				KEYZORI_SERVER_PORT: "3200",
			}),
		).toMatchObject({
			host: "server-host",
			port: 3200,
		});
	});

	test("requires valid immediate proxy networks when headers are trusted", () => {
		expect(
			loadServerConfig({
				...validEnvironment,
				KEYZORI_TRUSTED_PROXY_HEADER: "cf-connecting-ip",
			}).trustedProxyHeader,
		).toBe("cf-connecting-ip");
		expect(
			loadServerConfig({
				...validEnvironment,
				KEYZORI_TRUSTED_PROXY_HEADER: "x-real-ip",
			}).trustedProxyHeader,
		).toBe("x-real-ip");
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				KEYZORI_TRUST_PROXY_HEADERS: "true",
			}),
		).toThrow("KEYZORI_TRUSTED_PROXY_CIDRS must list");
		expect(
			loadServerConfig({
				...validEnvironment,
				KEYZORI_TRUST_PROXY_HEADERS: "true",
				KEYZORI_TRUSTED_PROXY_CIDRS: "10.0.0.0/8,2001:db8::/32",
			}).trustedProxyCidrs,
		).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
		expect(
			loadServerConfig({
				...validEnvironment,
				KEYZORI_TRUST_PROXY_HEADERS: "true",
				KEYZORI_TRUSTED_PROXY_HEADER: "*",
				KEYZORI_TRUSTED_PROXY_CIDRS: "*",
			}),
		).toMatchObject({
			trustedProxyHeader: "*",
			trustedProxyCidrs: ["*"],
		});
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				KEYZORI_TRUST_PROXY_HEADERS: "true",
				KEYZORI_TRUSTED_PROXY_CIDRS: "not-a-network",
			}),
		).toThrow("IPv4 or IPv6 CIDR");
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				KEYZORI_TRUST_PROXY_HEADERS: "true",
				KEYZORI_TRUSTED_PROXY_CIDRS: "*,10.0.0.0/8",
			}),
		).toThrow("either * or comma-separated");
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				KEYZORI_TRUSTED_PROXY_HEADER: "forwarded",
			}),
		).toThrow("KEYZORI_TRUSTED_PROXY_HEADER must be x-forwarded-for");
	});

	test("requires one direct admin password", () => {
		expect(() =>
			loadServerConfig({ ...validEnvironment, KEYZORI_ADMIN_PASS: "" }),
		).toThrow("KEYZORI_ADMIN_PASS must be configured");
	});

	test("rejects invalid typed settings", () => {
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				KEYZORI_SERVER_PORT: "70000",
			}),
		).toThrow("KEYZORI_SERVER_PORT must be an integer");
		expect(() =>
			loadServerConfig({ ...validEnvironment, KEYZORI_OPENAPI_ENABLED: "yes" }),
		).toThrow("KEYZORI_OPENAPI_ENABLED must be either true or false");
	});

	test("rejects malformed or unsupported dependency URLs", () => {
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				KEYZORI_DATABASE_URL: "not-a-url",
			}),
		).toThrow("KEYZORI_DATABASE_URL must be a valid URL");
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				KEYZORI_REDIS_URL: "https://redis.test",
			}),
		).toThrow("KEYZORI_REDIS_URL must use redis or rediss");
	});

	test("enables Stripe only with a complete credential pair", () => {
		expect(
			loadServerConfig({
				...validEnvironment,
				KEYZORI_STRIPE_SECRET_KEY: "sk_test_a_complete_stripe_secret",
				KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_a_complete_webhook_secret",
			}).stripe,
		).toEqual({
			secretKey: "sk_test_a_complete_stripe_secret",
			webhookSecret: "whsec_a_complete_webhook_secret",
		});
		expect(() =>
			loadServerConfig({
				...validEnvironment,
				KEYZORI_STRIPE_SECRET_KEY: "sk_test_a_complete_stripe_secret",
			}),
		).toThrow("must either both be configured or both be omitted");
	});
});
