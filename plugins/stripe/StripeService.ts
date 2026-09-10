import type { PluginContext } from "../../src/plugins/contract.ts";
import { LicenseRepository } from "../../src/licenses/LicenseRepository.ts";
import type { Executor } from "../../src/database/Database.ts";
import { AppError } from "../../src/shared/errors.ts";
import {
	collection,
	pagination,
	type pageQuery,
} from "../../src/shared/schemas.ts";
import type { StripeGateway, BillingState } from "./StripeGateway.ts";
import type { StripeRepository, ClaimedEvent } from "./StripeRepository.ts";
import type { eventQuery } from "./schemas.ts";

export class StripeService {
	private readonly licenses;
	constructor(
		private readonly context: PluginContext,
		private readonly repository: StripeRepository,
		private readonly gateway: StripeGateway,
	) {
		this.licenses = new LicenseRepository(context.database);
	}
	async link(licenseId: string, subscriptionId: string) {
		return this.context.database.orm.transaction(async (tx) => {
			const license = await this.licenses.lock(tx, licenseId);
			if (license.type !== "subscription")
				throw new AppError(
					"INVALID_TYPE",
					"Billing links require a subscription license.",
				);
			const existing = await this.repository.link(licenseId, tx);
			if (existing && existing.subscriptionId !== subscriptionId)
				throw new AppError(
					"LINK_CONFLICT",
					"Unlink the existing subscription first.",
					409,
				);
			const state = await this.gateway.subscription(subscriptionId);
			if (state.status === "missing")
				throw new AppError("NOT_FOUND", "Subscription not found.", 404);
			return this.apply(tx, licenseId, state);
		});
	}
	async unlink(licenseId: string) {
		return this.context.database.orm.transaction(async (tx) => {
			await this.licenses.lock(tx, licenseId);
			const result = await this.repository.unlink(tx, licenseId);
			await this.context.services.access.setBlock(
				tx,
				licenseId,
				"stripe",
				null,
			);
			return result;
		});
	}
	async sync(licenseId: string) {
		return this.context.database.orm.transaction(async (tx) => {
			await this.licenses.lock(tx, licenseId);
			const link = await this.repository.link(licenseId, tx);
			if (!link)
				throw new AppError("NOT_FOUND", "Billing link not found.", 404);
			return this.apply(
				tx,
				licenseId,
				await this.gateway.subscription(link.subscriptionId),
				link.customerId,
			);
		});
	}
	async webhook(raw: Uint8Array, signature: string) {
		const event = await this.gateway.verify(raw, signature);
		await this.repository.enqueue(
			event.id,
			event.type,
			this.gateway.subscriptionId(event),
		);
		return { received: true };
	}
	async process(event: ClaimedEvent) {
		const link = event.subscriptionId
			? await this.repository.bySubscription(event.subscriptionId)
			: undefined;
		await this.context.database.orm.transaction(async (tx) => {
			if (link) await this.licenses.lock(tx, link.licenseId);
			if (!(await this.repository.owns(tx, event))) return;
			if (link) {
				const current = await this.repository.link(link.licenseId, tx);
				if (current?.subscriptionId === event.subscriptionId)
					await this.apply(
						tx,
						link.licenseId,
						await this.gateway.subscription(current.subscriptionId),
						current.customerId,
					);
			}
			await this.repository.complete(tx, event);
		});
	}
	async links(query: typeof pageQuery.infer) {
		const page = pagination(query);
		return collection(await this.repository.links(page), page);
	}
	async events(query: typeof eventQuery.infer) {
		const page = pagination(query);
		return collection(await this.repository.events(page, query.state), page);
	}
	retry(id: string) {
		return this.repository.requeue(id);
	}
	private async apply(
		tx: Executor,
		licenseId: string,
		state: BillingState,
		customerId = state.customerId,
	) {
		const license = await this.licenses.lock(tx, licenseId);
		const active =
			license.type === "subscription" &&
			["active", "trialing"].includes(state.status) &&
			state.expiresAt &&
			state.expiresAt.getTime() > Date.now() &&
			customerId === state.customerId;
		if (license.type === "subscription" && state.expiresAt)
			await this.licenses.renew(tx, licenseId, state.expiresAt);
		await this.context.services.access.setBlock(
			tx,
			licenseId,
			"stripe",
			active ? null : "Billing subscription does not permit access.",
		);
		return this.repository.save(tx, {
			licenseId,
			subscriptionId: state.subscriptionId,
			customerId,
			status: state.status,
		});
	}
}
