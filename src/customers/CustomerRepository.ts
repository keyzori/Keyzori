import { eq, asc } from "drizzle-orm";
import type { Executor } from "../database/Database.ts";
import type { Page } from "../shared/schemas.ts";
import { customers } from "./tables.ts";

export class CustomerRepository {
	constructor(private readonly db: Executor) {}
	async get(id: string, tx = this.db) {
		return (await tx.select().from(customers).where(eq(customers.id, id)))[0];
	}
	list(page: Page) {
		return this.db
			.select()
			.from(customers)
			.orderBy(asc(customers.id))
			.limit(page.limit + 1)
			.offset(page.offset);
	}
	async create(tx: Executor, input: typeof customers.$inferInsert) {
		return (await tx.insert(customers).values(input).returning())[0];
	}
	async update(
		tx: Executor,
		id: string,
		input: Pick<typeof customers.$inferInsert, "email" | "name" | "metadata">,
	) {
		return (
			await tx
				.update(customers)
				.set({ ...input, updatedAt: new Date() })
				.where(eq(customers.id, id))
				.returning()
		)[0];
	}
	async delete(tx: Executor, id: string) {
		return (
			await tx.delete(customers).where(eq(customers.id, id)).returning()
		)[0];
	}
}
