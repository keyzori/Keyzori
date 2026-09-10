import { and, eq, sql } from "drizzle-orm";
import type { Database, Executor } from "../database/Database.ts";
import { licenses, subscriptions, trials } from "./tables.ts";
import type { licenseConfig, licenseQuery } from "./schemas.ts";
import type { Page } from "../shared/schemas.ts";
import { required } from "../shared/errors.ts";

export class LicenseRepository {
	constructor(private readonly database: Database) {}
	async lock(tx: Executor, id: string) {
		return required(
			(
				await tx
					.select()
					.from(licenses)
					.where(eq(licenses.id, id))
					.for("update")
			)[0],
			"License",
		);
	}
	async lockByKey(tx: Executor, hash: string) {
		return (
			await tx
				.select()
				.from(licenses)
				.where(eq(licenses.keyHash, hash))
				.for("update")
		)[0];
	}
	async get(id: string, tx: Executor = this.database.orm) {
		return tx.query.licenses.findFirst({
			where: { id },
			with: { subscription: true, trial: true, blocks: true },
		});
	}
	list(query: typeof licenseQuery.infer, page: Page) {
		return this.database.orm
			.select()
			.from(licenses)
			.where(
				and(
					query.customerId
						? eq(licenses.customerId, query.customerId)
						: undefined,
					query.type ? eq(licenses.type, query.type) : undefined,
				),
			)
			.orderBy(licenses.id)
			.limit(page.limit + 1)
			.offset(page.offset);
	}
	async create(tx: Executor, input: typeof licenses.$inferInsert) {
		return required((await tx.insert(licenses).values(input).returning())[0]);
	}
	async update(
		tx: Executor,
		id: string,
		changes: Partial<typeof licenses.$inferInsert>,
	) {
		return required(
			(
				await tx
					.update(licenses)
					.set({
						...changes,
						policyRevision: sql`${licenses.policyRevision} + 1`,
						updatedAt: new Date(),
					})
					.where(eq(licenses.id, id))
					.returning()
			)[0],
			"License",
		);
	}
	async replaceConfig(
		tx: Executor,
		id: string,
		config: typeof licenseConfig.infer,
	) {
		await tx.delete(subscriptions).where(eq(subscriptions.licenseId, id));
		await tx.delete(trials).where(eq(trials.licenseId, id));
		if (config.type === "subscription")
			await tx
				.insert(subscriptions)
				.values({ licenseId: id, expiresAt: new Date(config.expiresAt) });
		if (config.type === "trial")
			await tx
				.insert(trials)
				.values({ licenseId: id, durationSeconds: config.durationSeconds });
	}
	async renew(tx: Executor, id: string, expiresAt: Date) {
		await tx
			.update(subscriptions)
			.set({ expiresAt })
			.where(eq(subscriptions.licenseId, id));
	}
	async activateTrial(tx: Executor, id: string, duration: number) {
		const activatedAt = new Date();
		await tx
			.update(trials)
			.set({
				activatedAt,
				expiresAt: new Date(activatedAt.getTime() + duration * 1000),
			})
			.where(eq(trials.licenseId, id));
	}
}

export function publicLicense<T extends typeof licenses.$inferSelect>(row: T) {
	const { keyHash: _keyHash, ...visible } = row;
	return visible;
}
export type LicenseDetails = NonNullable<
	Awaited<ReturnType<LicenseRepository["get"]>>
>;
