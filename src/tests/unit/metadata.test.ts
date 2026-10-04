import { describe, expect, test } from "bun:test";
import { Check } from "typebox/value";
import { InputPolicy } from "../../core/http/InputPolicy";
import { httpModel } from "../../core/http/model";
import type { $Metadata, $MetadataValue } from "../../types/metadata";

const policy = new InputPolicy();
const nested = (depth: number) => {
	let value: $MetadataValue = true;
	for (let index = 0; index < depth; index++) value = { child: value };
	return value;
};

describe("recursive metadata policy", () => {
	test("accepts JSON values, empty containers, shared references and depth 16", () => {
		const shared = { valid: true };
		const metadata = {
			value: { strings: ["text", ""], mixed: [1.25, false, null, {}, []] },
			first: shared,
			second: shared,
		};
		expect(() => policy.metadata(metadata)).not.toThrow();
		expect(() =>
			policy.metadata(Object.assign(Object.create(null), metadata)),
		).not.toThrow();
		expect(() => policy.metadata(nested(16))).not.toThrow();
		expect(() => policy.metadata(nested(17))).toThrow();
		expect(Check(httpModel.metadata, metadata)).toBe(true);
		expect(
			Check(JSON.parse(JSON.stringify(httpModel.metadata)), metadata),
		).toBe(true);
	});
	test("rejects every dangerous property at any object depth", () => {
		for (const key of ["__proto__", "constructor", "prototype"]) {
			const property = JSON.parse(`{"${key}":true}`);
			for (const value of [
				property,
				{ nested: property },
				{ array: [property] },
			]) {
				expect(() => policy.metadata(value)).toThrow();
				expect(Check(httpModel.metadata, value)).toBe(false);
			}
		}
	});
	test("requires a root object and finite JSON values", () => {
		for (const value of [null, [], 1, true, "text"]) {
			expect(() => policy.metadata(value)).toThrow();
			expect(Check(httpModel.metadata, value)).toBe(false);
		}
		for (const value of [
			undefined,
			NaN,
			Infinity,
			-Infinity,
			1n,
			Symbol(),
			() => 1,
		])
			expect(() => policy.metadata({ value })).toThrow();
		expect(() => policy.metadata()).not.toThrow();
	});
	test("rejects cycles, nonplain objects, accessors and array holes or additions", () => {
		const cycle: $Metadata = {};
		cycle.child = cycle;
		const accessor = Object.defineProperty({}, "read", {
			enumerable: true,
			get: () => {
				throw new Error("getter must not run");
			},
		});
		const array = Object.assign([1], { extra: true });
		for (const value of [
			cycle,
			{ value: new Date() },
			accessor,
			{ array },
			{ array: Array(1) },
			{ [Symbol()]: 1 },
			Object.create({ inherited: true }),
		])
			expect(() => policy.metadata(value)).toThrow("Request validation failed");
	});
	test("bounds property counts, array lengths and keys at nested levels", () => {
		const object = Object.fromEntries(
			Array.from({ length: 64 }, (_, index) => [`key${index}`, null]),
		);
		expect(() =>
			policy.metadata({
				object,
				array: Array(256).fill(null),
				["😀".repeat(128)]: true,
			}),
		).not.toThrow();
		for (const value of [
			{ nested: { ...object, extra: 0 } },
			{ array: Array(257).fill(null) },
			{ nested: { "": true } },
			{ nested: { ["😀".repeat(129)]: true } },
		])
			expect(() => policy.metadata(value)).toThrow();
	});
	test("bounds total nodes independently of per-container limits", () => {
		const arrays = Array.from({ length: 16 }, () => Array(254).fill(null));
		for (let index = 0; index < 7; index++)
			arrays[index] = Array(256).fill(null);
		expect(() => policy.metadata({ arrays })).not.toThrow();
		arrays[7]?.push(null);
		expect(() => policy.metadata({ arrays })).toThrow();
	});
	test("measures string and serialized JSON limits in UTF-8 bytes", () => {
		expect(() => policy.metadata({ value: "😀".repeat(2048) })).not.toThrow();
		expect(() => policy.metadata({ value: "😀".repeat(2049) })).toThrow();
		const strings = Array(127).fill("x".repeat(8192));
		expect(() => policy.metadata({ strings })).not.toThrow();
		strings.push("x".repeat(8192));
		expect(() => policy.metadata({ strings })).toThrow();
		const escaped = Array(22).fill("\u0001".repeat(8192));
		expect(() => policy.metadata({ escaped })).toThrow();
	});
	test("rejects JSONB-incompatible text in keys and strings", () => {
		for (const text of ["\0", "\ud800", "\udfff"]) {
			expect(() => policy.metadata({ nested: { text } })).toThrow();
			expect(() => policy.metadata({ nested: { [text]: true } })).toThrow();
		}
	});
});
