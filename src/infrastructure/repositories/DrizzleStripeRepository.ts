import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type {
	StripeSubscriptionLink,
	StripeWebhookEvent,
} from "../../domain/entities";
import type {
	IStripeSubscriptionRepository,
	IStripeWebhookRepository,
	NewStripeSubscriptionLink,
	NewStripeWebhookEvent,
	StripeSubscriptionLinkUpdate,
	StripeWebhookEnqueueResult,
} from "../../domain/repositories/IStripeRepository";
import type { Database } from "../../db";
import {
	licenses,
	stripeSubscriptionLinks,
	stripeWebhookEvents,
} from "../../db/schema";

type DatabaseTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];
type StripeDatabase = Database | DatabaseTransaction;

function firstOrThrow<T>(rows: T[], action: string): T {
	const row = rows[0];
	if (!row) throw new Error(`Database returned no row after ${action}.`);
	return row;
}

function nextLicenseUpdatedAt() {
	return sql`greatest(clock_timestamp()::timestamp, ${licenses.updatedAt} + interval '1 millisecond')`;
}

export class DrizzleStripeSubscriptionRepository
	implements IStripeSubscriptionRepository
{
	private readonly db: StripeDatabase;
	private readonly transactionRunner: Database | null;

	constructor(db: StripeDatabase, transactionRunner?: Database | null) {
		this.db = db;
		this.transactionRunner =
			transactionRunner === undefined ? (db as Database) : transactionRunner;
	}

	async withSubscriptionReconciliationLock<T>(
		subscriptionId: string,
		operation: (repository: IStripeSubscriptionRepository) => Promise<T>,
	): Promise<T> {
		if (!this.transactionRunner) return await operation(this);
		return await this.transactionRunner.transaction(async (transaction) => {
			await transaction.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${`stripe:${subscriptionId}`}, 0))`,
			);
			return await operation(
				new DrizzleStripeSubscriptionRepository(transaction, null),
			);
		});
	}

	async createForSubscriptionLicense(
		data: NewStripeSubscriptionLink,
	): Promise<StripeSubscriptionLink | null> {
		return await this.withTransaction(async (transaction) => {
			const licenseRows = await transaction
				.select({ type: licenses.type })
				.from(licenses)
				.where(eq(licenses.id, data.licenseId))
				.limit(1)
				.for("update");
			if (licenseRows[0]?.type !== "subscription") return null;
			if (!data.paidThrough) {
				throw new Error(
					"A Stripe-linked subscription requires paid-through access.",
				);
			}
			const rows = await transaction
				.insert(stripeSubscriptionLinks)
				.values({ id: crypto.randomUUID(), ...data })
				.returning();
			const link = firstOrThrow(rows, "linking a Stripe subscription");
			await transaction
				.update(licenses)
				.set({
					expiresAt: data.paidThrough,
					updatedAt: nextLicenseUpdatedAt(),
				})
				.where(eq(licenses.id, data.licenseId));
			return link;
		});
	}

	async findByLicenseId(
		licenseId: string,
	): Promise<StripeSubscriptionLink | null> {
		const rows = await this.db
			.select()
			.from(stripeSubscriptionLinks)
			.where(eq(stripeSubscriptionLinks.licenseId, licenseId))
			.limit(1);
		return rows[0] ?? null;
	}

	async findBySubscriptionId(
		subscriptionId: string,
	): Promise<StripeSubscriptionLink | null> {
		const rows = await this.db
			.select()
			.from(stripeSubscriptionLinks)
			.where(eq(stripeSubscriptionLinks.subscriptionId, subscriptionId))
			.limit(1);
		return rows[0] ?? null;
	}

	async updateBySubscriptionId(
		subscriptionId: string,
		data: StripeSubscriptionLinkUpdate,
	): Promise<StripeSubscriptionLink> {
		const rows = await this.db
			.update(stripeSubscriptionLinks)
			.set({ ...data, updatedAt: new Date() })
			.where(eq(stripeSubscriptionLinks.subscriptionId, subscriptionId))
			.returning();
		return firstOrThrow(rows, "updating a Stripe subscription link");
	}

	async reconcileForSubscriptionLicense(
		subscriptionId: string,
		data: StripeSubscriptionLinkUpdate,
	): Promise<StripeSubscriptionLink | null> {
		return await this.withTransaction(async (transaction) => {
			const candidateRows = await transaction
				.select({ licenseId: stripeSubscriptionLinks.licenseId })
				.from(stripeSubscriptionLinks)
				.where(eq(stripeSubscriptionLinks.subscriptionId, subscriptionId))
				.limit(1);
			const candidate = candidateRows[0];
			if (!candidate) return null;
			const licenseRows = await transaction
				.select({ type: licenses.type })
				.from(licenses)
				.where(eq(licenses.id, candidate.licenseId))
				.limit(1)
				.for("update");
			const existingRows = await transaction
				.select()
				.from(stripeSubscriptionLinks)
				.where(
					and(
						eq(stripeSubscriptionLinks.subscriptionId, subscriptionId),
						eq(stripeSubscriptionLinks.licenseId, candidate.licenseId),
					),
				)
				.limit(1)
				.for("update");
			const existing = existingRows[0];
			if (!existing) return null;
			if (licenseRows[0]?.type !== "subscription") {
				await transaction
					.delete(stripeSubscriptionLinks)
					.where(eq(stripeSubscriptionLinks.id, existing.id));
				return null;
			}
			const rows = await transaction
				.update(stripeSubscriptionLinks)
				.set({ ...data, updatedAt: new Date() })
				.where(eq(stripeSubscriptionLinks.subscriptionId, subscriptionId))
				.returning();
			const link = firstOrThrow(rows, "reconciling a Stripe subscription link");
			if (data.paidThrough) {
				await transaction
					.update(licenses)
					.set({
						expiresAt: data.paidThrough,
						updatedAt: nextLicenseUpdatedAt(),
					})
					.where(eq(licenses.id, existing.licenseId));
			}
			return link;
		});
	}

	async setBillingRevocation(
		subscriptionId: string,
		billingRevokedAt: Date | null,
	): Promise<StripeSubscriptionLink> {
		return await this.updateBySubscriptionId(subscriptionId, {
			billingRevokedAt,
		});
	}

	async deleteByLicenseId(licenseId: string): Promise<boolean> {
		const rows = await this.db
			.delete(stripeSubscriptionLinks)
			.where(eq(stripeSubscriptionLinks.licenseId, licenseId))
			.returning({ id: stripeSubscriptionLinks.id });
		return rows.length > 0;
	}

	private async withTransaction<T>(
		operation: (transaction: StripeDatabase) => Promise<T>,
	): Promise<T> {
		if (!this.transactionRunner) return await operation(this.db);
		return await this.transactionRunner.transaction(operation);
	}
}

export class DrizzleStripeWebhookRepository
	implements IStripeWebhookRepository
{
	constructor(private readonly db: Database) {}

	async enqueue(
		data: NewStripeWebhookEvent,
	): Promise<StripeWebhookEnqueueResult> {
		const rows = await this.db
			.insert(stripeWebhookEvents)
			.values({
				...data,
				objectId: data.objectId ?? null,
				nextAttemptAt: data.nextAttemptAt ?? new Date(),
			})
			.onConflictDoNothing()
			.returning();
		if (rows[0]) return { event: rows[0], inserted: true };
		const existing = await this.findById(data.eventId);
		if (!existing) throw new Error("Stripe webhook event could not be loaded.");
		return { event: existing, inserted: false };
	}

	async claimDue(
		limit: number,
		now = new Date(),
	): Promise<StripeWebhookEvent[]> {
		if (!Number.isInteger(limit) || limit < 1) return [];
		const leaseUntil = new Date(now.getTime() + 60_000);
		return await this.db.transaction(async (transaction) => {
			const rows = await transaction
				.select()
				.from(stripeWebhookEvents)
				.where(
					and(
						inArray(stripeWebhookEvents.status, [
							"pending",
							"failed",
							"processing",
						]),
						lte(stripeWebhookEvents.nextAttemptAt, now),
					),
				)
				.orderBy(asc(stripeWebhookEvents.nextAttemptAt))
				.limit(Math.min(limit, 100))
				.for("update", { skipLocked: true });
			if (rows.length === 0) return [];
			const eventIds = rows.map((row) => row.eventId);
			await transaction
				.update(stripeWebhookEvents)
				.set({
					status: "processing",
					attempts: sql`${stripeWebhookEvents.attempts} + 1`,
					lastError: null,
					nextAttemptAt: leaseUntil,
				})
				.where(inArray(stripeWebhookEvents.eventId, eventIds));
			return rows.map((row) => ({
				...row,
				status: "processing" as const,
				attempts: row.attempts + 1,
				lastError: null,
				nextAttemptAt: leaseUntil,
			}));
		});
	}

	async markProcessed(
		eventId: string,
		processedAt = new Date(),
	): Promise<void> {
		await this.db
			.update(stripeWebhookEvents)
			.set({ status: "processed", processedAt, lastError: null })
			.where(eq(stripeWebhookEvents.eventId, eventId));
	}

	async markFailed(
		eventId: string,
		error: string,
		nextAttemptAt: Date,
	): Promise<void> {
		await this.db
			.update(stripeWebhookEvents)
			.set({ status: "failed", lastError: error, nextAttemptAt })
			.where(eq(stripeWebhookEvents.eventId, eventId));
	}

	async findById(eventId: string): Promise<StripeWebhookEvent | null> {
		const rows = await this.db
			.select()
			.from(stripeWebhookEvents)
			.where(eq(stripeWebhookEvents.eventId, eventId))
			.limit(1);
		return rows[0] ?? null;
	}
}
