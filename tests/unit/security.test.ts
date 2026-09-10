import { expect, test } from "bun:test";
import { ClientIp, normalizeIp } from "../../src/shared/ClientIp.ts";
import { Config } from "../../src/shared/Config.ts";
import {
	digest,
	equalSecret,
	metadata,
	redact,
	secret,
} from "../../src/shared/security.ts";
import { databaseCode, required } from "../../src/shared/errors.ts";
import { collection, pagination } from "../../src/shared/schemas.ts";

const config = new Config({
	KEYZORI_ADMIN_KEY: "test-only-admin-key-at-least-32-characters",
	KEYZORI_DATABASE_URL: "postgresql://localhost/test",
	KEYZORI_REDIS_URL: "redis://localhost",
	KEYZORI_TRUSTED_PROXIES: "10.0.0.0/8,2001:db8::/32",
});
const resolver = new ClientIp(config);
const request = (forwarded?: string) =>
	new Request("http://localhost", {
		headers: forwarded ? { "x-forwarded-for": forwarded } : {},
	});

test.each([
	["::ffff:192.0.2.1", "192.0.2.1"],
	["::ffff:c000:201", "192.0.2.1"],
	["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
	["127.0.0.1", "127.0.0.1"],
])("canonicalizes %s", (input, expected) =>
	expect(normalizeIp(input)).toBe(expected),
);
test.each(["", "localhost", "127.1", "192.168.1.999", "[::1]", "fe80::1%eth0"])(
	"rejects IP %s",
	(value) => {
		expect(() => normalizeIp(value)).toThrow("valid IP");
	},
);
test("ignores spoofed forwarding from an untrusted peer", () => {
	expect(resolver.resolve(request("garbage"), "192.0.2.1")).toBe("192.0.2.1");
});
test("walks trusted hops right to left and stops before attacker-supplied hops", () => {
	expect(
		resolver.resolve(request("garbage, 198.51.100.1, 10.1.1.1"), "10.2.2.2"),
	).toBe("198.51.100.1");
	expect(
		resolver.resolve(request("2001:db9::1, 2001:db8::2"), "2001:db8::3"),
	).toBe("2001:db9::1");
});
test("rejects missing peers, malformed trusted hops, and oversized chains", () => {
	expect(() => resolver.resolve(request(), undefined)).toThrow("unavailable");
	expect(() => resolver.resolve(request("bad"), "10.1.1.1")).toThrow(
		"valid IP",
	);
	expect(() =>
		resolver.resolve(request(Array(33).fill("10.1.1.1").join(",")), "10.2.2.2"),
	).toThrow("Too many");
});
test("secrets are unique, correctly sized, and compared without length errors", () => {
	const values = Array.from({ length: 100 }, () => secret("lic"));
	expect(new Set(values).size).toBe(100);
	for (const value of values) expect(value).toMatch(/^lic_[A-Za-z0-9_-]{43}$/);
	expect(secret("ses")).toMatch(/^ses_[A-Za-z0-9_-]{43}$/);
	expect(digest("abc")).toBe(
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
	expect(equalSecret("a", "a")).toBe(true);
	for (const other of ["", "b", "a".repeat(10000)])
		expect(equalSecret("a", other)).toBe(false);
});
test.each([
	"secret",
	"accessToken",
	"Password",
	"authorization",
	"cookie",
	"credential",
	"api_key",
	"licenseKey",
	"keyHash",
	"deviceId",
	"ipAddress",
])("redacts sensitive field %s recursively", (key) => {
	expect(redact({ nested: [{ [key]: "private", safe: "ok" }] })).toEqual({
		nested: [{ [key]: "[REDACTED]", safe: "ok" }],
	});
});
test("redacts embedded credentials and preserves ordinary primitive values", () => {
	expect(
		redact("lic_abcdef ses_abcdef sk_test_abc rk_live_abc whsec_abc"),
	).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
	expect(redact([null, 1, true, "ordinary"])).toEqual([
		null,
		1,
		true,
		"ordinary",
	]);
});
test("metadata enforces its exact size boundary without mutating input", () => {
	const value = { x: "a".repeat(8184) };
	expect(JSON.stringify(value).length).toBe(8192);
	expect(metadata(value)).toEqual(value);
	expect(() => metadata({ x: "a".repeat(8185) })).toThrow("8192");
	const input = { token: "private" };
	expect(metadata(input).token).toBe("[REDACTED]");
	expect(input.token).toBe("private");
});
test("deep and cyclic object redaction terminates safely", () => {
	const value: Record<string, unknown> = {};
	value.child = value;
	expect(JSON.stringify(redact(value))).toContain("[REDACTED]");
});
test.each(["0", "101", "1.5", "-1", "9007199254740992"])(
	"rejects invalid page limit %s",
	(limit) => {
		expect(() => pagination({ limit })).toThrow("Limit must");
	},
);
test.each(["-1", "1000001", "1.5", "9007199254740992"])(
	"rejects invalid page offset %s",
	(offset) => {
		expect(() => pagination({ offset })).toThrow("Limit must");
	},
);
test("pages retain lookahead semantics and never mutate source rows", () => {
	expect(pagination({})).toEqual({ limit: 50, offset: 0 });
	expect(pagination({ limit: "100", offset: "1000000" })).toEqual({
		limit: 100,
		offset: 1000000,
	});
	const rows = [1, 2, 3];
	expect(collection(rows, { limit: 2, offset: 4 })).toEqual({
		items: [1, 2],
		limit: 2,
		offset: 4,
		hasMore: true,
	});
	expect(collection([1, 2], { limit: 2, offset: 0 }).hasMore).toBe(false);
	expect(rows).toEqual([1, 2, 3]);
});
test("database codes unwrap driver causes and ignore unrelated errors", () => {
	expect(databaseCode({ cause: { errno: "23505" } })).toBe("23505");
	expect(databaseCode({ code: "23503" })).toBe("23503");
	for (const value of [null, "23505", { code: "ECONNRESET" }, {}])
		expect(databaseCode(value)).toBeUndefined();
	for (const value of [0, false, ""]) expect(required(value)).toBe(value);
	expect(() => required(null, "Customer")).toThrow("Customer not found");
});
