import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { StripeGateway } from "../../plugins/stripe/StripeGateway.ts";
import { StripeConfig } from "../../plugins/stripe/StripeConfig.ts";

const gateway = new StripeGateway(
	new StripeConfig({
		KEYZORI_STRIPE_SECRET_KEY: "sk_test_fake",
		KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_test",
	}),
);
const bytes = (value: string) => new TextEncoder().encode(value);
const signed = (body: string, timestamp = Math.floor(Date.now() / 1000)) =>
	`t=${timestamp},v1=${createHmac("sha256", "whsec_test").update(`${timestamp}.${body}`).digest("hex")}`;
const raw = JSON.stringify({
	id: "evt_test",
	type: "customer.subscription.updated",
	data: { object: { id: "sub_test" } },
});
test("verifies signed raw bytes including whitespace", async () => {
	expect((await gateway.verify(bytes(raw), signed(raw))).id).toBe("evt_test");
	const spaced = `${raw}\n`;
	expect((await gateway.verify(bytes(spaced), signed(spaced))).id).toBe(
		"evt_test",
	);
	await expect(
		gateway.verify(bytes(spaced), signed(raw)),
	).rejects.toMatchObject({ code: "WEBHOOK_SIGNATURE" });
});
test.each(["", "invalid", "t=1,v1=bad"])(
	"rejects signature %s",
	async (signature) => {
		await expect(gateway.verify(bytes(raw), signature)).rejects.toMatchObject({
			code: "WEBHOOK_SIGNATURE",
			status: 400,
		});
	},
);
test("rejects expired signatures and signed malformed event payloads", async () => {
	await expect(
		gateway.verify(bytes(raw), signed(raw, 1)),
	).rejects.toMatchObject({ code: "WEBHOOK_SIGNATURE" });
	for (const invalid of ["{}", '{"id":"evt_test"}']) {
		await expect(
			gateway.verify(bytes(invalid), signed(invalid)),
		).rejects.toMatchObject({ code: "WEBHOOK_PAYLOAD" });
	}
});
test.each([
	["customer.subscription.deleted", { id: "sub_deleted" }, "sub_deleted"],
	[
		"invoice.paid",
		{ parent: { subscription_details: { subscription: "sub_invoice" } } },
		"sub_invoice",
	],
	[
		"invoice.payment_failed",
		{
			parent: {
				subscription_details: { subscription: { id: "sub_expanded" } },
			},
		},
		"sub_expanded",
	],
	["invoice.paid", { parent: null }, null],
	["customer.created", { id: "cus_test" }, null],
] as const)("extracts subscription for %s", async (type, object, expected) => {
	const body = JSON.stringify({ id: "evt_extract", type, data: { object } });
	expect(
		gateway.subscriptionId(await gateway.verify(bytes(body), signed(body))),
	).toBe(expected);
});
