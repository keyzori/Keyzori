import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { StripeConfig } from "../../plugins/stripe/StripeConfig.ts";
import {
	StripeGateway,
	type BillingState,
} from "../../plugins/stripe/StripeGateway.ts";
import { StripeRepository } from "../../plugins/stripe/StripeRepository.ts";
import { StripeService } from "../../plugins/stripe/StripeService.ts";
import { StripeWorker } from "../../plugins/stripe/StripeWorker.ts";
import { stripeEvents } from "../../plugins/stripe/tables.ts";

const env = {
	KEYZORI_PLUGINS: "stripe",
	KEYZORI_STRIPE_SECRET_KEY: "sk_test_fake",
	KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_testsecret",
};
export function signed(
	body: string,
	timestamp = Math.floor(Date.now() / 1000),
) {
	return `t=${timestamp},v1=${createHmac("sha256", env.KEYZORI_STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
}
class FakeGateway extends StripeGateway {
	state: BillingState = {
		subscriptionId: "sub_test",
		customerId: "cus_test",
		status: "active",
		expiresAt: new Date(Date.now() + 86400000),
	};
	fail = false;
	calls = 0;
	constructor() {
		super(new StripeConfig(env));
	}
	override async subscription(id: string) {
		this.calls++;
		if (this.fail) throw new Error("simulated provider outage");
		return { ...this.state, subscriptionId: id };
	}
}

describe.skipIf(!integrationAvailable)("independent billing plugin", () => {
	let ctx: TestContext;
	let gateway: FakeGateway;
	let repository: StripeRepository;
	let service: StripeService;
	let worker: StripeWorker;
	beforeAll(async () => {
		ctx = new TestContext(env);
		await ctx.start();
		for (const hook of ctx.app.app.event.stop ?? []) await hook.fn(ctx.app.app);
		gateway = new FakeGateway();
		repository = new StripeRepository(ctx.app.services.database);
		service = new StripeService(ctx.app.context, repository, gateway);
		worker = new StripeWorker(repository, service, ctx.app.services.logger);
	});
	afterAll(async () => {
		await worker?.stop();
		await ctx?.close();
	});
	test("constructor prefix, admin protection, and separate journals", async () => {
		expect(
			(await ctx.request("/plugins/stripe/admin/links", "GET", undefined, {}))
				.status,
		).toBe(401);
		expect((await ctx.request("/plugins/stripe/admin/events")).status).toBe(
			200,
		);
		expect((await ctx.request("/admin/stripe/links")).status).toBe(404);
		const spec = (await ctx.request("/openapi.json")).body;
		expect(spec.paths["/plugins/stripe/admin/links"].get.security).toEqual([
			{ adminKey: [] },
		]);
		expect(spec.paths["/plugins/stripe/webhook"].post.security).toBeUndefined();
		const journals = await ctx.app.services.database.sql<
			{ tablename: string }[]
		>`SELECT tablename FROM pg_tables WHERE schemaname = 'keyzori_migrations' ORDER BY tablename`;
		expect(journals.map((row) => row.tablename)).toEqual([
			"core",
			"plugin_stripe",
		]);
	});
	test("raw signature verification, duplicate persistence, and replay rejection", async () => {
		const body = JSON.stringify({
			id: "evt_signed",
			type: "customer.subscription.updated",
			data: { object: { id: "sub_signed" } },
		});
		const request = (raw: string, signature: string) =>
			fetch(`${ctx.url}/plugins/stripe/webhook`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"stripe-signature": signature,
				},
			});
		expect((await request(body, signed(body))).status).toBe(200);
		expect((await request(body, signed(body))).status).toBe(200);
		expect((await request(`${body} `, signed(body))).status).toBe(400);
		expect((await request(body, signed(body, 1))).status).toBe(400);
		expect((await request("{}", "invalid")).status).toBe(400);
		const rows = await ctx.app.services.database.orm
			.select()
			.from(stripeEvents)
			.where(eq(stripeEvents.eventId, "evt_signed"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("pending");
		await worker.tick();
	});
	test("duplicate and reordered events reconcile current state without clearing manual blocks", async () => {
		const license = await ctx.license("subscription");
		await service.link(license.id, "sub_test");
		await ctx.app.services.access.block(
			license.id,
			"Manual security revocation",
		);
		gateway.state.status = "past_due";
		await service.sync(license.id);
		expect(
			(await ctx.app.services.licenses.get(license.id)).blocks
				.map((b) => b.source)
				.sort(),
		).toEqual(["manual", "stripe"]);
		gateway.state.status = "active";
		await repository.enqueue(
			"evt_new",
			"customer.subscription.updated",
			"sub_test",
		);
		await repository.enqueue(
			"evt_old",
			"customer.subscription.deleted",
			"sub_test",
		);
		await worker.tick();
		await worker.tick();
		expect(
			(await ctx.app.services.licenses.get(license.id)).blocks.map(
				(b) => b.source,
			),
		).toEqual(["manual"]);
		await service.unlink(license.id);
		expect(
			(await ctx.app.services.licenses.get(license.id)).blocks.map(
				(b) => b.source,
			),
		).toEqual(["manual"]);
	});
	test("worker retries survive provider outage and expired claims recover", async () => {
		const license = await ctx.license("subscription");
		await service.link(license.id, "sub_retry");
		const event = await repository.enqueue(
			"evt_retry",
			"customer.subscription.updated",
			"sub_retry",
		);
		gateway.fail = true;
		await worker.tick();
		gateway.fail = false;
		const failed = (
			await ctx.app.services.database.orm
				.select()
				.from(stripeEvents)
				.where(eq(stripeEvents.id, event.id))
		)[0];
		expect(failed?.state).toBe("pending");
		expect(failed?.attempts).toBe(1);
		await repository.requeue(event.id);
		const abandoned = await repository.claim();
		if (!abandoned) throw new Error("Missing claim");
		await ctx.app.services.database.orm
			.update(stripeEvents)
			.set({ leaseUntil: new Date(Date.now() - 1000) })
			.where(eq(stripeEvents.id, abandoned.id));
		const recovered = await repository.claim();
		if (!recovered) throw new Error("Missing recovered claim");
		expect(recovered.claim).not.toBe(abandoned.claim);
		await service.process(abandoned);
		expect(
			(
				await ctx.app.services.database.orm
					.select()
					.from(stripeEvents)
					.where(eq(stripeEvents.id, event.id))
			)[0]?.state,
		).toBe("processing");
		await service.process(recovered);
		expect(
			(
				await ctx.app.services.database.orm
					.select()
					.from(stripeEvents)
					.where(eq(stripeEvents.id, event.id))
			)[0]?.state,
		).toBe("completed");
	});
	test("disabling and re-enabling retains plugin tables, journals, and restrictions", async () => {
		const license = await ctx.license("subscription");
		gateway.state.status = "past_due";
		await service.link(license.id, "sub_disabled");
		await ctx.restart({ KEYZORI_PLUGINS: "" });
		expect((await ctx.request("/plugins/stripe/admin/events")).status).toBe(
			404,
		);
		await expect(ctx.activate(license.key)).rejects.toMatchObject({
			code: "LICENSE_BLOCKED",
		});
		await ctx.restart({ KEYZORI_PLUGINS: "stripe" });
		expect((await ctx.request("/plugins/stripe/admin/links")).status).toBe(200);
		await expect(ctx.activate(license.key)).rejects.toMatchObject({
			code: "LICENSE_BLOCKED",
		});
	});
});
