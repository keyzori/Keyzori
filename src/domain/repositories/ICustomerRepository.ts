import type { Customer, JsonObject } from "../entities";

export type CustomerUpdate = Partial<
	Pick<Customer, "email" | "name" | "metadata">
>;

export interface ICustomerRepository {
	create(email: string, name: string, metadata: JsonObject): Promise<Customer>;
	findById(id: string): Promise<Customer | null>;
	findAll(): Promise<Customer[]>;
	update(id: string, data: CustomerUpdate): Promise<Customer>;
	delete(id: string): Promise<void>;
}
