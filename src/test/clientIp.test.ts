import { describe, expect, test } from "bun:test";
import { getClientIp } from "../controllers/clientIp";

describe("getClientIp", () => {
	test("ignores forwarded headers by default", () => {
		const request = new Request("http://localhost", {
			headers: { "x-forwarded-for": "203.0.113.10" },
		});
		expect(
			getClientIp(request, null, {
				trustProxyHeaders: false,
				trustedProxyCidrs: [],
			}),
		).toBe("127.0.0.1");
	});

	test("stops at the first untrusted address when walking from the edge", () => {
		const request = new Request("http://localhost", {
			headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.2" },
		});
		expect(
			getClientIp(request, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["127.0.0.0/8"],
			}),
		).toBe("10.0.0.2");
	});

	test("ignores proxy headers from untrusted peers and invalid addresses", () => {
		const untrusted = new Request("http://localhost", {
			headers: { "x-forwarded-for": "203.0.113.10" },
		});
		expect(
			getClientIp(untrusted, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["10.0.0.0/8"],
			}),
		).toBe("127.0.0.1");

		const invalid = new Request("http://localhost", {
			headers: { "cf-connecting-ip": "not-an-ip" },
		});
		expect(
			getClientIp(invalid, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["127.0.0.0/8"],
			}),
		).toBe("127.0.0.1");
	});

	test("walks trusted proxy hops without accepting a spoofed left entry", () => {
		const request = new Request("http://localhost", {
			headers: {
				"x-forwarded-for": "198.51.100.99, 203.0.113.20, 10.0.0.2",
			},
		});
		expect(
			getClientIp(request, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["127.0.0.0/8", "10.0.0.0/8"],
			}),
		).toBe("203.0.113.20");
	});

	test("uses CF-Connecting-IP only in explicit Cloudflare mode", () => {
		const request = new Request("http://localhost", {
			headers: {
				"cf-connecting-ip": "203.0.113.44",
				"x-forwarded-for": "198.51.100.11",
			},
		});
		const base = {
			trustProxyHeaders: true,
			trustedProxyCidrs: ["127.0.0.0/8"],
		};
		expect(getClientIp(request, null, base)).toBe("198.51.100.11");
		expect(
			getClientIp(request, null, {
				...base,
				trustedProxyHeader: "cf-connecting-ip",
			}),
		).toBe("203.0.113.44");
	});

	test("uses X-Real-IP only in explicit Railway mode", () => {
		const request = new Request("http://localhost", {
			headers: {
				"x-real-ip": "203.0.113.45",
				"x-forwarded-for": "198.51.100.12",
			},
		});
		expect(
			getClientIp(request, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["127.0.0.0/8"],
				trustedProxyHeader: "x-real-ip",
			}),
		).toBe("203.0.113.45");
	});

	test("supports wildcard proxy networks", () => {
		const request = new Request("http://localhost", {
			headers: { "x-forwarded-for": "203.0.113.10" },
		});
		expect(
			getClientIp(request, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["*"],
			}),
		).toBe("203.0.113.10");
	});

	test("canonicalizes equivalent IPv6 spellings", () => {
		const request = new Request("http://localhost", {
			headers: { "x-forwarded-for": "2001:0DB8:0:0:0:0:0:1" },
		});
		expect(
			getClientIp(request, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["*"],
			}),
		).toBe("2001:db8::1");
		const mapped = new Request("http://localhost", {
			headers: { "x-forwarded-for": "::ffff:192.0.2.128" },
		});
		expect(
			getClientIp(mapped, null, {
				trustProxyHeaders: true,
				trustedProxyCidrs: ["*"],
			}),
		).toBe("::ffff:192.0.2.128");
	});

	test("auto-detects supported headers and rejects conflicts", () => {
		const options = {
			trustProxyHeaders: true,
			trustedProxyCidrs: ["*"],
			trustedProxyHeader: "*" as const,
		};
		expect(
			getClientIp(
				new Request("http://localhost", {
					headers: { "x-forwarded-for": "203.0.113.10" },
				}),
				null,
				options,
			),
		).toBe("203.0.113.10");
		expect(
			getClientIp(
				new Request("http://localhost", {
					headers: { "cf-connecting-ip": "203.0.113.20" },
				}),
				null,
				options,
			),
		).toBe("203.0.113.20");
		expect(
			getClientIp(
				new Request("http://localhost", {
					headers: { "x-real-ip": "203.0.113.25" },
				}),
				null,
				options,
			),
		).toBe("203.0.113.25");
		expect(
			getClientIp(
				new Request("http://localhost", {
					headers: {
						"x-forwarded-for": "203.0.113.30",
						"cf-connecting-ip": "203.0.113.30",
						"x-real-ip": "203.0.113.30",
					},
				}),
				null,
				options,
			),
		).toBe("203.0.113.30");
		expect(
			getClientIp(
				new Request("http://localhost", {
					headers: {
						"x-forwarded-for": "203.0.113.10",
						"cf-connecting-ip": "203.0.113.20",
					},
				}),
				null,
				options,
			),
		).toBe("127.0.0.1");
	});

	test("falls back to the socket for malformed or excessive chains", () => {
		for (const forwarded of [
			"203.0.113.1, not-an-ip",
			Array.from({ length: 33 }, (_, index) => `10.0.0.${index + 1}`).join(","),
		]) {
			expect(
				getClientIp(
					new Request("http://localhost", {
						headers: { "x-forwarded-for": forwarded },
					}),
					null,
					{
						trustProxyHeaders: true,
						trustedProxyCidrs: ["127.0.0.0/8"],
					},
				),
			).toBe("127.0.0.1");
		}
	});
});
