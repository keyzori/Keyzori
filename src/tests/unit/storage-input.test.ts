import { describe, expect, test } from "bun:test";
import { InputPolicy } from "../../core/http/InputPolicy";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import { users } from "../../core/database/schema/users";

const policy = new InputPolicy();
const query = (values: Record<string, string>) =>
	new ResourceQuery(new URLSearchParams(values), users);

describe("storage-compatible input", () => {
	test("preserves well-formed Unicode and rejects NUL or lone surrogates at any depth", () => {
		for (const text of ["", "ASCII", "\t\r\n", "é e\u0301 中文 😀", "\\u0000"])
			expect(() =>
				policy.jsonText({ [text]: [{ nested: text }] }),
			).not.toThrow();
		for (const text of ["\0", "prefix\0suffix", "\ud800", "\udfff", "a\ud800b"])
			for (const value of [
				text,
				{ [text]: "value" },
				{ array: [{ nested: text }] },
			])
				expect(() => policy.jsonText(value)).toThrow();
	});

	test("rejects unsafe query text and empty IDs before constructing SQL", () => {
		const malformed: Record<string, string>[] = [
			{ id: "" },
			{ search: "a\0b" },
			{ "metadata.x": "\0" },
			{ "metadata.a\0b": "safe" },
		];
		for (const values of malformed) expect(() => query(values)).toThrow();
		expect(() => query({})).not.toThrow();
		expect(() =>
			query({ id: "019943AA-ABCD-7000-8000-ABCDEF123456" }),
		).not.toThrow();
	});

	test("checks calendar validity, timezone and representable timestamp boundaries", () => {
		for (const value of [
			"2026-02-30T00:00:00Z",
			"2025-02-29T00:00:00Z",
			"1900-02-29T00:00:00Z",
			"2026-04-31T00:00:00Z",
			"2026-13-01T00:00:00Z",
			"2026-01-00T00:00:00Z",
			"0000-01-01T00:00:00Z",
			"0001-01-01T00:00:00+01:00",
			"9999-12-31T23:59:59-01:00",
			"2026-10-01T24:00:00Z",
			"2026-10-01T23:59:60Z",
			"2026-10-01T00:00:00+16:00",
			"2026-10-01T00:00:00",
			"2026-10-01",
			"Infinity",
			"",
		])
			expect(() => policy.timestamp(value), value).toThrow();
		for (const value of [
			"0001-01-01T00:00:00Z",
			"9999-12-31T23:59:59.999Z",
			"2000-02-29T00:00:00Z",
			"2024-02-29T12:30:00+05:30",
			"2026-10-01T00:00:00-15:59",
			"2026-10-01T00:00:00.123456Z",
		])
			expect(policy.timestamp(value).getTime(), value).toBe(Date.parse(value));
	});

	test("bounds numeric SQL casts without converting exact filters to floating point", () => {
		for (const value of [
			"0",
			"-0",
			"1.2500",
			"-1e-20",
			"5e-324",
			"1e-16383",
			"0e-16383",
			"0e131071",
			"9007199254740993",
			`0.${"0".repeat(16382)}1`,
		])
			expect(
				() => query({ "metadataNumber.cost": value }),
				value.slice(0, 30),
			).not.toThrow();
		for (const value of [
			"1e-16384",
			"0e-1000000",
			"1e-1000000",
			"0e131072",
			"0e99999999999999999999",
			"1e309",
			"Infinity",
			"NaN",
			"0x10",
			"01",
			"1.",
			" 1",
			`0.${"0".repeat(16383)}1`,
		])
			expect(
				() => query({ "metadataNumber.cost": value }),
				value.slice(0, 30),
			).toThrow();
	});
});
