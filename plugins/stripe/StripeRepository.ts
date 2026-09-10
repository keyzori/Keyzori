import { and, eq, sql } from "drizzle-orm";
import type { Database, Executor } from "../../src/database/Database.ts";
import { AppError, required } from "../../src/shared/errors.ts";
import type { Page } from "../../src/shared/schemas.ts";
import { stripeEvents, stripeLinks } from "./tables.ts";

export class StripeRepository {
	constructor(private readonly database: Database) {}
	async link(licenseId: string, tx: Executor = this.database.orm) {
		return (
			await tx
				.select()
				.from(stripeLinks)
				.where(eq(stripeLinks.licenseId, licenseId))
		)[0];
	}
	async bySubscription(subscriptionId: string) {
		return (
			await this.database.orm
				.select()
				.from(stripeLinks)
				.where(eq(stripeLinks.subscriptionId, subscriptionId))
		)[0];
	}
	links(page: Page) {
		return this.database.orm
			.select()
			.from(stripeLinks)
			.orderBy(stripeLinks.id)
			.limit(page.limit + 1)
			.offset(page.offset);
	}
	async save(tx: Executor, input: typeof stripeLinks.$inferInsert) {
		return required(
			(
				await tx
					.insert(stripeLinks)
					.values(input)
					.onConflictDoUpdate({
						target: stripeLinks.licenseId,
						set: {
							subscriptionId: input.subscriptionId,
							customerId: input.customerId,
							status: input.status,
							syncedAt: new Date(),
						},
					})
					.returning()
			)[0],
		);
	}
	async unlink(tx: Executor, licenseId: string) {
		return required(
			(
				await tx
					.delete(stripeLinks)
					.where(eq(stripeLinks.licenseId, licenseId))
					.returning()
			)[0],
			"Billing link",
		);
	}
	async enqueue(
		eventId: string,
		eventType: string,
		subscriptionId: string | null,
	) {
		await this.database.orm
			.insert(stripeEvents)
			.values({ eventId, eventType, subscriptionId })
			.onConflictDoNothing({ target: stripeEvents.eventId });
		const row = required(
			(
				await this.database.orm
					.select()
					.from(stripeEvents)
					.where(eq(stripeEvents.eventId, eventId))
			)[0],
		);
		if (row.eventType !== eventType || row.subscriptionId !== subscriptionId)
			throw new AppError(
				"EVENT_CONFLICT",
				"Webhook ID conflicts with a persisted event.",
				409,
			);
		return row;
	}
	events(page: Page, state?: string) {
		return this.database.orm
			.select({
				id: stripeEvents.id,
				eventId: stripeEvents.eventId,
				eventType: stripeEvents.eventType,
				subscriptionId: stripeEvents.subscriptionId,
				state: stripeEvents.state,
				attempts: stripeEvents.attempts,
				nextAttemptAt: stripeEvents.nextAttemptAt,
				createdAt: stripeEvents.createdAt,
				completedAt: stripeEvents.completedAt,
			})
			.from(stripeEvents)
			.where(state ? eq(stripeEvents.state, state) : undefined)
			.orderBy(stripeEvents.createdAt, stripeEvents.id)
			.limit(page.limit + 1)
			.offset(page.offset);
	}
	async claim() {
		return this.database.orm.transaction(async (tx) => {
			const event = (
				await tx
					.select()
					.from(stripeEvents)
					.where(
						sql`(${stripeEvents.state} = 'pending' AND ${stripeEvents.nextAttemptAt} <= now()) OR (${stripeEvents.state} = 'processing' AND ${stripeEvents.leaseUntil} <= now())`,
					)
					.orderBy(stripeEvents.nextAttemptAt, stripeEvents.id)
					.for("update", { skipLocked: true })
					.limit(1)
			)[0];
			if (!event) return;
			return required(
				(
					await tx
						.update(stripeEvents)
						.set({
							state: "processing",
							claim: crypto.randomUUID(),
							leaseUntil: sql`now() + interval '30 seconds'`,
							attempts: sql`${stripeEvents.attempts} + 1`,
						})
						.where(eq(stripeEvents.id, event.id))
						.returning()
				)[0],
			);
		});
	}
	async owns(tx: Executor, event: ClaimedEvent) {
		return Boolean(
			(
				await tx
					.select()
					.from(stripeEvents)
					.where(
						and(
							eq(stripeEvents.id, event.id),
							eq(stripeEvents.claim, required(event.claim)),
							eq(stripeEvents.state, "processing"),
							sql`${stripeEvents.leaseUntil} > now()`,
						),
					)
					.for("update")
			)[0],
		);
	}
	async complete(tx: Executor, event: ClaimedEvent) {
		await tx
			.update(stripeEvents)
			.set({
				state: "completed",
				completedAt: new Date(),
				claim: null,
				leaseUntil: null,
			})
			.where(
				and(
					eq(stripeEvents.id, event.id),
					eq(stripeEvents.claim, required(event.claim)),
				),
			);
	}
	async retry(event: ClaimedEvent) {
		const seconds = Math.min(3600, 2 ** Math.min(event.attempts, 11));
		await this.database.orm
			.update(stripeEvents)
			.set({
				state: "pending",
				claim: null,
				leaseUntil: null,
				nextAttemptAt: sql`now() + ${seconds} * interval '1 second'`,
			})
			.where(
				and(
					eq(stripeEvents.id, event.id),
					eq(stripeEvents.claim, required(event.claim)),
				),
			);
	}
	async requeue(id: string) {
		return required(
			(
				await this.database.orm
					.update(stripeEvents)
					.set({
						state: "pending",
						nextAttemptAt: new Date(),
						claim: null,
						leaseUntil: null,
					})
					.where(
						and(
							eq(stripeEvents.id, id),
							sql`${stripeEvents.state} <> 'processing' OR ${stripeEvents.leaseUntil} <= now()`,
						),
					)
					.returning({ id: stripeEvents.id, state: stripeEvents.state })
			)[0],
			"Retryable webhook event",
		);
	}
}

export type ClaimedEvent = NonNullable<
	Awaited<ReturnType<StripeRepository["claim"]>>
>;
