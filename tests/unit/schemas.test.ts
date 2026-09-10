import { expect, test } from "bun:test";
import { customerBody } from "../../src/customers/schemas.ts";
import {
	licenseConfig,
	licenseBody,
	licenseUpdate,
} from "../../src/licenses/schemas.ts";
import { policyBody, allowlistBody } from "../../src/access/schemas.ts";
import { meterBody, usageBody, meterName } from "../../src/meters/schemas.ts";
import {
	activationBody,
	sessionHeaders,
	sessionRecord,
} from "../../src/sessions/schemas.ts";
import { activityQuery } from "../../src/activity/schemas.ts";

const id = "ad05a134-4e1d-46f2-9402-b0b531c59596";
test.each(["", "invalid", "a@", "@example.com"])(
	"rejects customer email %s",
	(email) => {
		expect(customerBody.allows({ email, name: "Customer" })).toBe(false);
	},
);
test("customer fields enforce length, required fields, and strict properties", () => {
	const valid = {
		email: "a@example.com",
		name: "a".repeat(200),
		metadata: { arbitrary: [1, true] },
	};
	expect(customerBody.allows(valid)).toBe(true);
	for (const patch of [
		{ name: "" },
		{ name: "a".repeat(201) },
		{ metadata: [] },
		{ unknown: 1 },
	])
		expect(customerBody.allows({ ...valid, ...patch })).toBe(false);
	expect(customerBody.allows({ email: valid.email })).toBe(false);
});
test.each(["lifetime", "metered"])(
	"%s configuration rejects foreign type fields",
	(kind) => {
		expect(licenseConfig.allows({ type: kind })).toBe(true);
		for (const field of [
			"expiresAt",
			"durationSeconds",
			"activatedAt",
			"unexpected",
		])
			expect(licenseConfig.allows({ type: kind, [field]: 1 })).toBe(false);
	},
);
test.each([0, -1, 1.5, 31536001, NaN, Infinity])(
	"rejects trial duration %s",
	(durationSeconds) => {
		expect(licenseConfig.allows({ type: "trial", durationSeconds })).toBe(
			false,
		);
	},
);
test("license creation and changes reject missing, forged, or invalid fields", () => {
	for (const durationSeconds of [1, 31536000])
		expect(licenseConfig.allows({ type: "trial", durationSeconds })).toBe(true);
	expect(
		licenseConfig.allows({
			type: "subscription",
			expiresAt: "2030-01-01T00:00:00Z",
		}),
	).toBe(true);
	expect(
		licenseConfig.allows({ type: "subscription", expiresAt: "yesterday" }),
	).toBe(false);
	expect(
		licenseBody.allows({ customerId: id, config: { type: "lifetime" } }),
	).toBe(true);
	for (const value of [
		{},
		{ customerId: "invalid", config: { type: "lifetime" } },
		{ customerId: id, config: { type: "unknown" } },
	])
		expect(licenseBody.allows(value)).toBe(false);
	for (const field of ["keyHash", "policyRevision", "type", "key"])
		expect(licenseUpdate.allows({ [field]: "forged" })).toBe(false);
});
test.each(["maxDevices", "maxIps", "maxSessions"])(
	"%s policy is bounded and integer-only",
	(field) => {
		for (const value of [1, 10000])
			expect(policyBody.allows({ [field]: value })).toBe(true);
		for (const value of [0, -1, 1.5, 10001, "1", null])
			expect(policyBody.allows({ [field]: value })).toBe(false);
	},
);
test("allowlist size is bounded independently for devices and networks", () => {
	expect(
		allowlistBody.allows({
			devices: Array(100).fill("d"),
			networks: Array(100).fill("::1"),
		}),
	).toBe(true);
	for (const field of ["devices", "networks"])
		expect(
			allowlistBody.allows({
				devices: [],
				networks: [],
				[field]: Array(101).fill("x"),
			}),
		).toBe(false);
});
test.each(["", "A", "_a", "a b", "a/b", "a".repeat(65)])(
	"rejects meter name %s",
	(value) => expect(meterName.allows(value)).toBe(false),
);
test("meter limits allow zero but usage always requires positive safe integers", () => {
	for (const limit of [0, Number.MAX_SAFE_INTEGER])
		expect(meterBody.allows({ licenseId: id, name: "exports", limit })).toBe(
			true,
		);
	for (const units of [
		0,
		-1,
		0.5,
		Number.MAX_SAFE_INTEGER + 1,
		Infinity,
		NaN,
		"1",
	])
		expect(
			usageBody.allows({ meter: "exports", units, eventId: "event" }),
		).toBe(false);
	expect(
		usageBody.allows({
			meter: "exports",
			units: Number.MAX_SAFE_INTEGER,
			eventId: "a".repeat(128),
		}),
	).toBe(true);
	for (const eventId of ["", "a".repeat(129)])
		expect(usageBody.allows({ meter: "exports", units: 1, eventId })).toBe(
			false,
		);
});
test("activation rejects forged key formats and oversized devices", () => {
	const key = `lic_${"a".repeat(43)}`;
	expect(activationBody.allows({ key, deviceId: "d".repeat(256) })).toBe(true);
	for (const value of [
		key.slice(0, -1),
		`${key}a`,
		key.replace("lic_", "ses_"),
		"plain",
	])
		expect(activationBody.allows({ key: value, deviceId: "d" })).toBe(false);
	for (const deviceId of ["", "d".repeat(257)])
		expect(activationBody.allows({ key, deviceId })).toBe(false);
});
test("runtime headers require the exact bearer format and device binding", () => {
	const authorization = `Bearer ses_${"a".repeat(43)}`;
	expect(
		sessionHeaders.allows({
			authorization,
			"x-device-id": "d",
			"content-type": "application/json",
		}),
	).toBe(true);
	for (const value of [
		authorization.toLowerCase(),
		authorization.replace("Bearer ", ""),
		`${authorization} `,
		"Bearer invalid",
	])
		expect(
			sessionHeaders.allows({ authorization: value, "x-device-id": "d" }),
		).toBe(false);
	expect(sessionHeaders.allows({ authorization })).toBe(false);
});
test("stored session records reject corrupt fields and unknown data", () => {
	const record = {
		licenseId: id,
		deviceHash: "a".repeat(64),
		ip: "::1",
		revision: 1,
	};
	expect(sessionRecord.allows(record)).toBe(true);
	for (const patch of [
		{ revision: 0 },
		{ revision: 1.5 },
		{ licenseId: "invalid" },
		{ deviceHash: "short" },
		{ secret: "unexpected" },
	])
		expect(sessionRecord.allows({ ...record, ...patch })).toBe(false);
});
test("activity query validates identifiers, timestamps, and filter lengths", () => {
	expect(
		activityQuery.allows({
			from: "2026-01-01T00:00:00Z",
			to: "2027-01-01T00:00:00Z",
			licenseId: id,
		}),
	).toBe(true);
	for (const value of [
		{ from: "yesterday" },
		{ customerId: "bad" },
		{ action: "a".repeat(101) },
		{ source: "a".repeat(65) },
		{ unexpected: 1 },
	])
		expect(activityQuery.allows(value)).toBe(false);
});
