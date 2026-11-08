import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyWebhook } from "../../examples/verify-webhook";

test("receiver example verifies raw bytes, age, event identity and payload shape", () => {
	const secret = "ab".repeat(32);
	const keyId = Bun.randomUUIDv7();
	const deliveryId = Bun.randomUUIDv7();
	const eventId = Bun.randomUUIDv7();
	const licenseId = Bun.randomUUIDv7();
	const timestamp = "1800000000";
	const body = JSON.stringify({
		schemaVersion: 1,
		id: eventId,
		event: "license.created",
		createdAt: "2026-11-06T00:00:00.000Z",
		resource: { type: "license", id: licenseId, revision: "1" },
		data: { licenseId, groupId: null },
	});
	const signed = (text: string) =>
		new Headers({
			"x-keyzori-signing-key-id": keyId,
			"x-keyzori-delivery-id": deliveryId,
			"x-keyzori-event-id": eventId,
			"x-keyzori-timestamp": timestamp,
			"x-keyzori-signature": `v1=${createHmac("sha256", Buffer.from(secret, "hex")).update(`${timestamp}.${deliveryId}.${text}`).digest("hex")}`,
		});
	const keys = new Map([[keyId, secret]]);
	expect(
		verifyWebhook(Buffer.from(body), signed(body), keys, Number(timestamp)),
	).toMatchObject({ deliveryId, event: { id: eventId } });
	expect(() =>
		verifyWebhook(
			Buffer.from(`${body} `),
			signed(body),
			keys,
			Number(timestamp),
		),
	).toThrow("signature");
	expect(() =>
		verifyWebhook(
			Buffer.from(body),
			signed(body),
			keys,
			Number(timestamp) + 301,
		),
	).toThrow("authentication");
	const mismatched = signed(body);
	mismatched.set("x-keyzori-event-id", Bun.randomUUIDv7());
	expect(() =>
		verifyWebhook(Buffer.from(body), mismatched, keys, Number(timestamp)),
	).toThrow("event");
	const invalid = body.replace('"license.created"', '"unknown.event"');
	expect(() =>
		verifyWebhook(
			Buffer.from(invalid),
			signed(invalid),
			keys,
			Number(timestamp),
		),
	).toThrow("event");
	const incomplete = body.replace(',"groupId":null', "");
	expect(() =>
		verifyWebhook(
			Buffer.from(incomplete),
			signed(incomplete),
			keys,
			Number(timestamp),
		),
	).toThrow("event");
});
