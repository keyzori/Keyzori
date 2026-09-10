import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { StripeRepository } from "../../plugins/stripe/StripeRepository.ts";
import { StripeService } from "../../plugins/stripe/StripeService.ts";
import { StripeGateway } from "../../plugins/stripe/StripeGateway.ts";
import { StripeConfig } from "../../plugins/stripe/StripeConfig.ts";
import { StripeWorker } from "../../plugins/stripe/StripeWorker.ts";
import { stripeEvents } from "../../plugins/stripe/tables.ts";

describe.skipIf(!integrationAvailable)("billing queue concurrency", () => {
	let ctx: TestContext;
	let repository: StripeRepository;
	beforeAll(async () => {
		ctx = await new TestContext({
			KEYZORI_PLUGINS: "stripe",
			KEYZORI_STRIPE_SECRET_KEY: "sk_test_fake",
			KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_fake",
		}).start();
		for (const hook of ctx.app.app.event.stop ?? []) await hook.fn(ctx.app.app);
		repository = new StripeRepository(ctx.app.services.database);
	});
	afterAll(async () => {
		await ctx?.close();
	});
	test("concurrent workers claim each event only once", async () => {
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				repository.enqueue(`evt_parallel_${i}`, "test.ignored", null),
			),
		);
		const results = await Promise.all(
			Array.from({ length: 24 }, () => repository.claim()),
		);
		const claims = results.filter((value) => value !== undefined);
		expect(claims).toHaveLength(12);
		expect(new Set(claims.map((row) => row.id)).size).toBe(12);
		for (const claim of claims) {
			expect(claim.attempts).toBe(1);
			expect(claim.claim).toBeTruthy();
			await ctx.app.services.database.orm.transaction((tx) =>
				repository.complete(tx, claim),
			);
		}
	});
	test("concurrent duplicate deliveries persist one event and conflicting reuse fails", async () => {
		const rows = await Promise.all(
			Array.from({ length: 16 }, () =>
				repository.enqueue("evt_duplicate", "test.ignored", null),
			),
		);
		expect(new Set(rows.map((row) => row.id)).size).toBe(1);
		await expect(
			repository.enqueue("evt_duplicate", "different.type", null),
		).rejects.toMatchObject({ code: "EVENT_CONFLICT" });
		await expect(
			repository.enqueue("evt_duplicate", "test.ignored", "sub_different"),
		).rejects.toMatchObject({ code: "EVENT_CONFLICT" });
		const claim = await repository.claim();
		if (!claim) throw new Error("Missing claim");
		await ctx.app.services.database.orm.transaction((tx) =>
			repository.complete(tx, claim),
		);
	});
	test("active leases cannot be requeued, expired leases replace ownership", async () => {
		const event = await repository.enqueue("evt_lease", "test.ignored", null);
		const first = await repository.claim();
		if (!first) throw new Error("Missing claim");
		await expect(repository.requeue(event.id)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await ctx.app.services.database.orm
			.update(stripeEvents)
			.set({ leaseUntil: new Date(Date.now() - 1000) })
			.where(eq(stripeEvents.id, event.id));
		const replacement = await repository.claim();
		if (!replacement) throw new Error("Missing replacement");
		expect(replacement.claim).not.toBe(first.claim);
		expect(replacement.attempts).toBe(2);
		await repository.retry(first);
		const [current] = await ctx.app.services.database.orm
			.select()
			.from(stripeEvents)
			.where(eq(stripeEvents.id, event.id));
		expect(current?.claim).toBe(replacement.claim);
		expect(current?.state).toBe("processing");
		await ctx.app.services.database.orm.transaction(async (tx) => {
			expect(await repository.owns(tx, first)).toBe(false);
			expect(await repository.owns(tx, replacement)).toBe(true);
			await repository.complete(tx, replacement);
		});
	});
	test("retry delays further claims and explicit requeue makes the event available", async () => {
		const event = await repository.enqueue("evt_backoff", "test.ignored", null);
		const claim = await repository.claim();
		if (!claim) throw new Error("Missing claim");
		await repository.retry(claim);
		expect(await repository.claim()).toBeUndefined();
		await repository.requeue(event.id);
		const retried = await repository.claim();
		if (!retried) throw new Error("Missing retry");
		expect(retried.attempts).toBe(2);
		await ctx.app.services.database.orm.transaction((tx) =>
			repository.complete(tx, retried),
		);
		expect(
			await repository.events({ limit: 100, offset: 0 }, "pending"),
		).toHaveLength(0);
	});
	test("worker ticks coalesce and shutdown waits for outstanding processing", async () => {
		await repository.enqueue("evt_drain", "test.ignored", null);
		const service = new StripeService(
			ctx.app.context,
			repository,
			new StripeGateway(new StripeConfig(ctx.env)),
		);
		const original = service.process.bind(service);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const process = spyOn(service, "process").mockImplementation(
			async (event) => {
				entered();
				await gate;
				await original(event);
			},
		);
		const worker = new StripeWorker(
			repository,
			service,
			ctx.app.services.logger,
		);
		try {
			const first = worker.tick();
			expect(worker.tick()).toBe(first);
			await started;
			let stopped = false;
			const stop = worker.stop().then(() => {
				stopped = true;
			});
			await Bun.sleep(10);
			expect(stopped).toBe(false);
			release();
			await stop;
			expect(stopped).toBe(true);
			expect(process).toHaveBeenCalledTimes(1);
		} finally {
			release();
			await worker.stop();
			process.mockRestore();
		}
	});
});
