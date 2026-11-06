import { createHmac, timingSafeEqual } from "node:crypto";
import type { $EventEnvelope } from "../types/webhooks";
import { Check } from "typebox/value";
import { eventEnvelopeSchema } from "../plugins/webhooks/events";

/** Verify before parsing or processing; callers must durably deduplicate the returned IDs. */
export function verifyWebhook(
	bytes: Uint8Array,
	headers: Headers,
	secrets: ReadonlyMap<string, string>,
	nowSeconds = Math.floor(Date.now() / 1000),
): { deliveryId: string; event: $EventEnvelope } {
	const deliveryId = headers.get("x-keyzori-delivery-id") ?? "";
	const eventId = headers.get("x-keyzori-event-id") ?? "";
	const timestamp = headers.get("x-keyzori-timestamp") ?? "";
	const keyId = headers.get("x-keyzori-signing-key-id") ?? "";
	const signature = headers.get("x-keyzori-signature") ?? "";
	const secret = secrets.get(keyId);
	const uuid =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (
		bytes.byteLength > 32768 ||
		!uuid.test(deliveryId) ||
		!uuid.test(eventId) ||
		!/^\d{1,12}$/.test(timestamp) ||
		Math.abs(nowSeconds - Number(timestamp)) > 300 ||
		!secret ||
		!/^[0-9a-f]{64}$/i.test(secret) ||
		!/^v1=[0-9a-f]{64}$/i.test(signature)
	)
		throw new Error("Invalid webhook authentication");
	const expected = createHmac("sha256", Buffer.from(secret, "hex"))
		.update(`${timestamp}.${deliveryId}.`)
		.update(bytes)
		.digest();
	const supplied = Buffer.from(signature.slice(3), "hex");
	if (!timingSafeEqual(expected, supplied))
		throw new Error("Invalid webhook signature");
	const value: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(bytes),
	);
	if (!isEvent(value) || value.id !== eventId)
		throw new Error("Invalid webhook event");
	return { deliveryId, event: value };
}

function isEvent(value: unknown): value is $EventEnvelope {
	return Check(eventEnvelopeSchema, value);
}

// Use raw bounded request bytes. Verify, then insert deliveryId/event.id into a
// durable unique inbox and apply your side effect in the same transaction.
// Reply 2xx only after durable acceptance; a duplicate accepted event also gets 2xx.
