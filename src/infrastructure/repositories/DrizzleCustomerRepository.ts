import { desc, eq } from "drizzle-orm";
import type { Customer, JsonObject } from "../../domain/entities";
import { ConflictError } from "../../domain/errors";
import type {
	CustomerUpdate,
	ICustomerRepository,
} from "../../domain/repositories/ICustomerRepository";
import type { Database } from "../../db";
import { customers } from "../../db/schema";

function translateDuplicateEmail(error: unknown): never {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "23505" &&
		"constraint" in error &&
		error.constraint === "customers_email_unique"
	) {
		throw new ConflictError("A customer with this email already exists");
	}
	throw error;
}

export class DrizzleCustomerRepository implements ICustomerRepository {
	constructor(private readonly db: Database) {}

	async create(
		email: string,
		name: string,
		metadata: JsonObject,
	): Promise<Customer> {
		try {
			const rows = await this.db
				.insert(customers)
				.values({ id: crypto.randomUUID(), email, name, metadata })
				.returning();
			const customer = rows[0];
			if (!customer) throw new Error("Database returned no created customer.");
			return customer;
		} catch (error) {
			return translateDuplicateEmail(error);
		}
	}

	async findAll(): Promise<Customer[]> {
		return await this.db
			.select()
			.from(customers)
			.orderBy(desc(customers.createdAt));
	}

	async findById(id: string): Promise<Customer | null> {
		const rows = await this.db
			.select()
			.from(customers)
			.where(eq(customers.id, id))
			.limit(1);
		return rows[0] ?? null;
	}

	async update(id: string, data: CustomerUpdate): Promise<Customer> {
		try {
			const rows = await this.db
				.update(customers)
				.set({ ...data, updatedAt: new Date() })
				.where(eq(customers.id, id))
				.returning();
			const customer = rows[0];
			if (!customer) throw new Error("Database returned no updated customer.");
			return customer;
		} catch (error) {
			return translateDuplicateEmail(error);
		}
	}

	async delete(id: string): Promise<void> {
		await this.db.delete(customers).where(eq(customers.id, id));
	}
}
