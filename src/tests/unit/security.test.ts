import { describe, expect, spyOn, test } from "bun:test";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { SecretHasher } from "../../core/security/SecretHasher";

describe("credential security", () => {
	const generator = new KeyGenerator();
	const hasher = new SecretHasher();

	test("hashes exact input with SHA-256 and rejects altered or malformed digests", () => {
		expect(hasher.hash("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		const hash = hasher.hash("Exact Key ");
		expect(hasher.matches("Exact Key ", hash)).toBe(true);
		expect(hasher.matches("Exact Key", hash)).toBe(false);
		expect(hasher.matches("exact key ", hash)).toBe(false);
		expect(hasher.matches("Exact Key ", "bad")).toBe(false);
		expect(hasher.matches("Exact Key ", "g".repeat(64))).toBe(false);
	});

	test("master and API secrets contain 32 random bytes independently of service configuration", () => {
		const master = generator.master();
		expect(master).toMatch(/^kz_key_[a-f0-9]{64}$/);
		const id = Bun.randomUUIDv7();
		const result = generator.api(id);
		expect(result.secret).toMatch(/^[a-f0-9]{64}$/);
		expect(result.credential).toBe(`kz_key_${id}_${result.secret}`);
		expect(generator.master()).not.toBe(master);
		expect(() => generator.api(crypto.randomUUID())).toThrow("UUIDv7");
	});

	test("default licence format exceeds 160 bits and preserves formatting", () => {
		expect(32 * Math.log2(36)).toBeGreaterThanOrEqual(160);
		expect(generator.license()).toMatch(/^KZ(?:-[A-Z0-9]{8}){4}$/);
		expect(
			generator.license({
				prefix: " kz ",
				separator: "::",
				groups: 1,
				length: 32,
				charset: "hex",
			}),
		).toMatch(/^ kz ::[a-f0-9]{32}$/);
	});

	test("rejects weak, out-of-bounds and unknown format fields", () => {
		expect(() =>
			generator.license({
				...KeyGenerator.defaultFormat,
				groups: 1,
				length: 24,
			}),
		).toThrow("128 bits");
		expect(() =>
			generator.license({
				...KeyGenerator.defaultFormat,
				prefix: "x".repeat(129),
			}),
		).toThrow("format");
		expect(() =>
			generator.license({
				...KeyGenerator.defaultFormat,
				groups: 32,
				length: 128,
			}),
		).toThrow("4096");
		const unexpected = { ...KeyGenerator.defaultFormat, injected: true };
		expect(() => generator.license(unexpected)).toThrow("format");
	});

	test("printable ASCII formatting survives an Authorization header verbatim", () => {
		for (let code = 0x20; code <= 0x7e; code++) {
			const text = String.fromCharCode(code);
			const credential = generator.license({
				...KeyGenerator.defaultFormat,
				prefix: text,
				separator: text,
			});
			expect(
				new Headers({ Authorization: `Bearer ${credential}` }).get(
					"Authorization",
				),
			).toBe(`Bearer ${credential}`);
		}
	});

	test("rejects control and non-ASCII text at every prefix and separator boundary", () => {
		const invalid = [
			...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)),
			"\x7f",
			"\x80",
			"\u00e9",
			"\u4f60\u597d",
			"\ud83d\ude00",
			"\ud800",
		];
		for (const field of ["prefix", "separator"] as const)
			for (const text of invalid)
				for (const value of [text, `safe${text}`, `${text}safe`])
					expect(() =>
						generator.license({
							...KeyGenerator.defaultFormat,
							[field]: value,
						}),
					).toThrow("format");
	});

	test("accepts an empty format prefix and separator at exactly 4096 characters", () => {
		const format = {
			...KeyGenerator.defaultFormat,
			prefix: "",
			separator: "",
			groups: 32,
			length: 128,
		};
		const credential = generator.license(format);
		expect(credential).toHaveLength(4096);
		expect(
			new Headers({ Authorization: `Bearer ${credential}` }).get(
				"Authorization",
			),
		).toBe(`Bearer ${credential}`);
		expect(() => generator.license({ ...format, prefix: "x" })).toThrow("4096");
	});

	test("rejects bytes outside the unbiased alphabet range", () => {
		const randomness = spyOn(crypto, "getRandomValues").mockImplementationOnce(
			(array: Parameters<Crypto["getRandomValues"]>[0]) => {
				if (array instanceof Uint8Array) {
					array.fill(0);
					array[0] = 255;
					array[1] = 35;
				}
				return array;
			},
		);
		try {
			expect(
				generator.license({
					prefix: "",
					separator: "",
					groups: 1,
					length: 25,
					charset: "uppercase",
				}),
			).toBe(`9${"A".repeat(24)}`);
		} finally {
			randomness.mockRestore();
		}
	});
});
