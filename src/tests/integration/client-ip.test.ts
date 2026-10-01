import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "../../core/database/Database";
import { ClientIpResolver } from "../../core/http/ClientIpResolver";
import { HttpError } from "../../core/http/HttpError";

const url = process.env.KZ_TEST_DATABASE_URL;
if (!url)
	throw new Error(
		"KZ_TEST_DATABASE_URL is required for real PostgreSQL IP tests",
	);
const database = new Database(url, 2);
const resolver = new ClientIpResolver(
	database,
	["10.0.0.0/8", "2001:db8:abcd::/48"],
	["cf-connecting-ip", "x-real-ip", "x-forwarded-for"],
);

beforeAll(async () => {
	await database.ping();
});
afterAll(async () => {
	await database.close();
});

describe("trusted transport IPs", () => {
	test("untrusted peers cannot spoof any configured forwarding header", async () => {
		const headers = new Headers({
			"cf-connecting-ip": "10.0.0.1",
			"x-real-ip": "127.0.0.1",
			"x-forwarded-for": "10.0.0.2",
		});
		expect(await resolver.resolve("203.0.113.9", headers)).toBe("203.0.113.9");
		expect(
			await new ClientIpResolver(database).resolve("127.0.0.1", headers),
		).toBe("127.0.0.1");
	});

	test("trusted peers use configured header precedence and reject duplicate single-IP values", async () => {
		expect(
			await resolver.resolve(
				"10.1.2.3",
				new Headers({
					"cf-connecting-ip": "203.0.113.1",
					"x-real-ip": "203.0.113.2",
				}),
			),
		).toBe("203.0.113.1");
		expect(
			await resolver.resolve(
				"10.1.2.3",
				new Headers({
					"cf-connecting-ip": "203.0.113.1,203.0.113.2",
					"x-real-ip": "203.0.113.3",
				}),
			),
		).toBe("203.0.113.3");
	});

	test("XFF walks from the socket through trusted hops and stops at the first untrusted hop", async () => {
		expect(
			await resolver.resolve(
				"10.0.0.3",
				new Headers({
					"x-forwarded-for": "192.0.2.99, 198.51.100.7, 10.0.0.2",
				}),
			),
		).toBe("198.51.100.7");
		expect(
			await resolver.resolve(
				"10.0.0.3",
				new Headers({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }),
			),
		).toBe("10.0.0.1");
		expect(
			await resolver.resolve(
				"2001:db8:abcd::3",
				new Headers({ "x-forwarded-for": "2001:db8:99::1, 2001:db8:abcd::2" }),
			),
		).toBe("2001:db8:99::1");
	});

	test("malformed and oversized chains fall back without trusting a partial chain", async () => {
		for (const chain of [
			"198.51.100.1, nope, 10.0.0.2",
			"198.51.100.1,,10.0.0.2",
			"198.51.100.1:443",
			Array(129).fill("10.0.0.1").join(","),
		]) {
			expect(
				await resolver.resolve(
					"10.0.0.3",
					new Headers({ "x-forwarded-for": chain }),
				),
			).toBe("10.0.0.3");
		}
		const maximum = ["198.51.100.1", ...Array(127).fill("10.0.0.1")].join(",");
		expect(
			await resolver.resolve(
				"10.0.0.3",
				new Headers({ "x-forwarded-for": maximum }),
			),
		).toBe("198.51.100.1");
	});

	test("equivalent IPv6 and mapped IPv4 spellings have one canonical host identity", async () => {
		expect(
			await resolver.normalize("2001:0db8:0000:0000:0000:0000:0000:0001"),
		).toBe("2001:db8::1");
		expect(await resolver.normalize("::ffff:192.0.2.1")).toBe("192.0.2.1");
		expect(await resolver.normalize("::ffff:c000:0201")).toBe("192.0.2.1");
		expect(
			await resolver.resolve(
				"::ffff:10.0.0.3",
				new Headers({ "x-real-ip": "::ffff:198.51.100.4" }),
			),
		).toBe("198.51.100.4");
	});

	test("network matching normalizes host bits and mapped ranges with PostgreSQL semantics", async () => {
		await database.transaction(async (tx) => {
			expect(await resolver.matches(tx, "192.0.2.5", ["192.0.2.128/24"])).toBe(
				true,
			);
			expect(await resolver.matches(tx, "192.0.3.5", ["192.0.2.128/24"])).toBe(
				false,
			);
			expect(
				await resolver.matches(tx, "::ffff:192.0.2.5", ["192.0.2.0/24"]),
			).toBe(true);
			expect(
				await resolver.matches(tx, "192.0.2.5", ["::ffff:192.0.2.128/120"]),
			).toBe(true);
			expect(
				await resolver.matches(tx, "2001:db8::1", ["2001:0db8:0000::/32"]),
			).toBe(true);
			expect(await resolver.matches(tx, "192.0.2.5", ["0.0.0.0/0"])).toBe(true);
			expect(await resolver.matches(tx, "2001:db8::1", ["::/0"])).toBe(true);
			expect(await resolver.matches(tx, "::ffff:192.0.2.5", ["::/0"])).toBe(
				false,
			);
			expect(await resolver.matches(tx, "192.0.2.5", [])).toBe(false);
		});
	});

	test("rejects malformed rule syntax and absent transport identity", async () => {
		for (const rule of [
			"",
			"192.0.2.1:80",
			"[::1]",
			"fe80::1%eth0",
			"192.0.2.1/33",
			"::1/129",
			"127.0.0.1/",
			"192.0.2.1/24/1",
			" 192.0.2.1",
			"192.0.2.1/01",
		]) {
			expect(() => resolver.validateRules([rule])).toThrow(HttpError);
		}
		await expect(resolver.resolve(null, new Headers())).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		await expect(resolver.normalize("fe80::1%eth0")).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
	});
});
