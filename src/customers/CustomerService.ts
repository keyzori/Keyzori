import type { Database } from "../database/Database.ts";
import type { ActivityRepository } from "../activity/ActivityRepository.ts";
import type { CustomerRepository } from "./CustomerRepository.ts";
import type { customerBody } from "./schemas.ts";
import { collection, pagination, type pageQuery } from "../shared/schemas.ts";
import { metadata } from "../shared/security.ts";
import { required } from "../shared/errors.ts";

export class CustomerService {
	constructor(
		private readonly database: Database,
		private readonly repository: CustomerRepository,
		private readonly activity: ActivityRepository,
	) {}
	async get(id: string) {
		return required(await this.repository.get(id), "Customer");
	}
	async list(query: typeof pageQuery.infer) {
		const page = pagination(query);
		return collection(await this.repository.list(page), page);
	}
	async create(input: typeof customerBody.infer) {
		return this.database.orm.transaction(async (tx) => {
			const customer = required(
				await this.repository.create(tx, {
					...input,
					email: input.email.toLowerCase(),
					metadata: metadata(input.metadata),
				}),
			);
			await this.activity.write(tx, "customer.created", undefined, customer.id);
			return customer;
		});
	}
	async update(id: string, input: typeof customerBody.infer) {
		return this.database.orm.transaction(async (tx) => {
			const customer = required(
				await this.repository.update(tx, id, {
					...input,
					email: input.email.toLowerCase(),
					metadata: metadata(input.metadata),
				}),
				"Customer",
			);
			await this.activity.write(tx, "customer.updated", undefined, id);
			return customer;
		});
	}
	async delete(id: string) {
		return this.database.orm.transaction(async (tx) => {
			const customer = required(
				await this.repository.delete(tx, id),
				"Customer",
			);
			await this.activity.write(tx, "customer.deleted");
			return customer;
		});
	}
}
