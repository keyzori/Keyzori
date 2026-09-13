import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "../database/Database.ts";
import type { Page } from "../shared/schemas.ts";
import { meters, usageLedger } from "./tables.ts";
import { required } from "../shared/errors.ts";

export class MeterRepository {
	constructor(private readonly db: Executor) {}
	async get(id: string, tx = this.db) {
		return (await tx.select().from(meters).where(eq(meters.id, id)))[0];
	}
	list(licenseId: string, page: Page, meterId?: string) {
		return this.db
			.select()
			.from(meters)
			.where(
				and(
					eq(meters.licenseId, licenseId),
					meterId ? eq(meters.id, meterId) : undefined,
				),
			)
			.orderBy(meters.id)
			.limit(page.limit + 1)
			.offset(page.offset);
	}
	async create(tx: Executor, input: typeof meters.$inferInsert) {
		return required((await tx.insert(meters).values(input).returning())[0]);
	}
	reset(tx: Executor, licenseId: string) {
		return tx
			.update(meters)
			.set({ limit: 0, used: 0 })
			.where(eq(meters.licenseId, licenseId));
	}
	async setLimit(tx: Executor, id: string, limit: number) {
		return required(
			(
				await tx
					.update(meters)
					.set({ limit })
					.where(eq(meters.id, id))
					.returning()
			)[0],
		);
	}
	async byName(tx: Executor, licenseId: string, name: string) {
		return (
			await tx
				.select()
				.from(meters)
				.where(and(eq(meters.licenseId, licenseId), eq(meters.name, name)))
		)[0];
	}
	async event(tx: Executor, licenseId: string, eventId: string) {
		return (
			await tx
				.select()
				.from(usageLedger)
				.where(
					and(
						eq(usageLedger.licenseId, licenseId),
						eq(usageLedger.eventId, eventId),
					),
				)
		)[0];
	}
	async consume(
		tx: Executor,
		meterId: string,
		used: number,
		event: typeof usageLedger.$inferInsert,
	) {
		await tx.update(meters).set({ used }).where(eq(meters.id, meterId));
		return required(
			(await tx.insert(usageLedger).values(event).returning())[0],
		);
	}
	usage(licenseId: string, page: Page, meterId?: string) {
		return this.db
			.select()
			.from(usageLedger)
			.where(
				and(
					eq(usageLedger.licenseId, licenseId),
					meterId ? eq(usageLedger.meterId, meterId) : undefined,
				),
			)
			.orderBy(desc(usageLedger.createdAt), desc(usageLedger.id))
			.limit(page.limit + 1)
			.offset(page.offset);
	}
}
