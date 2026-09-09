import type {
	JsonObject,
	License,
	StripeSubscriptionLink,
} from "../../domain/entities";
import type { ILicenseRepository } from "../../domain/repositories/ILicenseRepository";
import type { IStripeSubscriptionRepository } from "../../domain/repositories/IStripeRepository";
import {
	type ActivityRecorder,
	noopActivityRecorder,
} from "../../application/services/ActivityService";
import type {
	StripeGatewayPort,
	StripeSubscriptionSnapshot,
} from "./StripeGateway";

export type StripeIntegrationErrorCode =
	| "LICENSE_NOT_FOUND"
	| "LICENSE_TYPE_INVALID"
	| "LICENSE_ALREADY_LINKED"
	| "SUBSCRIPTION_ALREADY_LINKED"
	| "SUBSCRIPTION_PERIOD_MISSING";

export class StripeIntegrationError extends Error {
	constructor(
		message: string,
		public readonly code: StripeIntegrationErrorCode,
		public readonly statusCode: number,
	) {
		super(message);
		this.name = "StripeIntegrationError";
	}
}

function subscriptionDetails(snapshot: StripeSubscriptionSnapshot): JsonObject {
	return {
		subscriptionId: snapshot.subscriptionId,
		stripeCustomerId: snapshot.stripeCustomerId,
		status: snapshot.status,
		paidThrough: snapshot.paidThrough?.toISOString() ?? null,
		cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
		priceId: snapshot.priceIds[0] ?? null,
		billingBlocked: snapshot.billingBlocked,
	};
}

function billingRevokedAt(
	snapshot: StripeSubscriptionSnapshot,
	existing: StripeSubscriptionLink | null,
	now: Date,
): Date | null {
	if (!snapshot.billingBlocked) return null;
	return existing?.billingRevokedAt ?? now;
}

export interface StripeLinkResult {
	link: StripeSubscriptionLink;
	license: License;
}

/** Operator-only linking and current-state reconciliation for Stripe subscriptions. */
export class StripeSubscriptionService {
	constructor(
		private readonly gateway: StripeGatewayPort,
		private readonly licenses: ILicenseRepository,
		private readonly links: IStripeSubscriptionRepository,
		private readonly activity: ActivityRecorder = noopActivityRecorder,
	) {}

	async getLink(licenseId: string): Promise<StripeSubscriptionLink | null> {
		return await this.links.findByLicenseId(licenseId);
	}

	async linkLicense(
		licenseId: string,
		subscriptionId: string,
		now = new Date(),
	): Promise<StripeLinkResult> {
		const license = await this.requireSubscriptionLicense(licenseId);
		let result:
			| {
					kind: "created";
					link: StripeSubscriptionLink;
					snapshot: StripeSubscriptionSnapshot;
			  }
			| { kind: "reconcile" };
		try {
			result = await this.links.withSubscriptionReconciliationLock(
				subscriptionId,
				async (links) => {
					const licenseLink = await links.findByLicenseId(licenseId);
					const subscriptionLink =
						await links.findBySubscriptionId(subscriptionId);
					if (licenseLink) {
						if (licenseLink.subscriptionId === subscriptionId) {
							return { kind: "reconcile" as const };
						}
						throw new StripeIntegrationError(
							"License is already linked to a Stripe subscription.",
							"LICENSE_ALREADY_LINKED",
							409,
						);
					}
					if (subscriptionLink) {
						throw new StripeIntegrationError(
							"Stripe subscription is already linked to another license.",
							"SUBSCRIPTION_ALREADY_LINKED",
							409,
						);
					}

					const snapshot = await this.gateway.getSubscription(subscriptionId);
					this.requirePaidThrough(snapshot);
					const created = await links.createForSubscriptionLicense({
						licenseId,
						subscriptionId: snapshot.subscriptionId,
						stripeCustomerId: snapshot.stripeCustomerId,
						status: snapshot.status,
						paidThrough: snapshot.paidThrough,
						cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
						priceId: snapshot.priceIds[0] ?? null,
						billingRevokedAt: billingRevokedAt(snapshot, null, now),
						lastSyncedAt: now,
						lastError: null,
					});
					if (!created) {
						throw new StripeIntegrationError(
							"Only subscription licenses can be linked to Stripe.",
							"LICENSE_TYPE_INVALID",
							422,
						);
					}
					return { kind: "created" as const, link: created, snapshot };
				},
			);
		} catch (error) {
			const [racedLicenseLink, racedSubscriptionLink] = await Promise.all([
				this.links.findByLicenseId(licenseId),
				this.links.findBySubscriptionId(subscriptionId),
			]);
			if (error instanceof StripeIntegrationError) throw error;
			if (racedLicenseLink) {
				throw new StripeIntegrationError(
					"License is already linked to a Stripe subscription.",
					"LICENSE_ALREADY_LINKED",
					409,
				);
			}
			if (racedSubscriptionLink) {
				throw new StripeIntegrationError(
					"Stripe subscription is already linked to another license.",
					"SUBSCRIPTION_ALREADY_LINKED",
					409,
				);
			}
			throw error;
		}
		if (result.kind === "reconcile") {
			const reconciled = await this.reconcileSubscription(subscriptionId, now);
			if (reconciled) return reconciled;
			throw new StripeIntegrationError(
				"License is already linked to a Stripe subscription.",
				"LICENSE_ALREADY_LINKED",
				409,
			);
		}

		const updatedLicense = await this.licenses.findById(license.id);
		if (updatedLicense?.type !== "subscription") {
			throw new Error("Stripe-linked license could not be reloaded.");
		}
		await this.activity.capture({
			type: "stripe.linked",
			source: "operator",
			licenseId,
			customerId: license.customerId,
			keyPrefix: license.keyPrefix,
			details: subscriptionDetails(result.snapshot),
		});
		return { link: result.link, license: updatedLicense };
	}

	async unlinkLicense(licenseId: string): Promise<boolean> {
		const [license, link] = await Promise.all([
			this.licenses.findById(licenseId),
			this.links.findByLicenseId(licenseId),
		]);
		if (!link) return false;
		const deleted = await this.links.deleteByLicenseId(licenseId);
		if (deleted) {
			await this.activity.capture({
				type: "stripe.unlinked",
				source: "operator",
				licenseId,
				customerId: license?.customerId ?? null,
				keyPrefix: license?.keyPrefix ?? null,
				details: { subscriptionId: link.subscriptionId },
			});
		}
		return deleted;
	}

	async syncLicense(
		licenseId: string,
		now = new Date(),
	): Promise<StripeLinkResult | null> {
		const link = await this.links.findByLicenseId(licenseId);
		if (!link) return null;
		return await this.reconcileSubscription(link.subscriptionId, now);
	}

	/** Always retrieves Stripe's current state; webhook payload ordering is irrelevant. */
	async reconcileSubscription(
		subscriptionId: string,
		now = new Date(),
	): Promise<StripeLinkResult | null> {
		const reconciled = await this.links.withSubscriptionReconciliationLock(
			subscriptionId,
			async (links) => {
				const existing = await links.findBySubscriptionId(subscriptionId);
				if (!existing) return null;
				const snapshot = await this.gateway.getSubscription(subscriptionId);
				const synchronizedAt =
					existing.lastSyncedAt && existing.lastSyncedAt > now
						? existing.lastSyncedAt
						: now;
				const link = await links.reconcileForSubscriptionLicense(
					subscriptionId,
					{
						stripeCustomerId: snapshot.stripeCustomerId,
						status: snapshot.status,
						paidThrough: snapshot.paidThrough,
						cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
						priceId: snapshot.priceIds[0] ?? null,
						billingRevokedAt: billingRevokedAt(
							snapshot,
							existing,
							synchronizedAt,
						),
						lastSyncedAt: synchronizedAt,
						lastError: null,
					},
				);
				return link ? { link, snapshot, licenseId: existing.licenseId } : null;
			},
		);
		if (!reconciled) return null;
		const updatedLicense = await this.licenses.findById(reconciled.licenseId);
		if (updatedLicense?.type !== "subscription") return null;
		await this.activity.capture({
			type: "stripe.synchronized",
			source: "stripe",
			licenseId: updatedLicense.id,
			customerId: updatedLicense.customerId,
			keyPrefix: updatedLicense.keyPrefix,
			details: subscriptionDetails(reconciled.snapshot),
		});
		return { link: reconciled.link, license: updatedLicense };
	}

	async recordReconciliationFailure(
		subscriptionId: string,
		error: string,
	): Promise<void> {
		const link = await this.links.findBySubscriptionId(subscriptionId);
		if (!link) return;
		await this.links.updateBySubscriptionId(subscriptionId, {
			lastError: error.slice(0, 1_000),
		});
	}

	private async requireSubscriptionLicense(
		licenseId: string,
	): Promise<License> {
		const license = await this.licenses.findById(licenseId);
		if (!license) {
			throw new StripeIntegrationError(
				"License not found.",
				"LICENSE_NOT_FOUND",
				404,
			);
		}
		if (license.type !== "subscription") {
			throw new StripeIntegrationError(
				"Only subscription licenses can be linked to Stripe.",
				"LICENSE_TYPE_INVALID",
				422,
			);
		}
		return license;
	}

	private requirePaidThrough(snapshot: StripeSubscriptionSnapshot): void {
		if (!snapshot.paidThrough) {
			throw new StripeIntegrationError(
				"Stripe subscription has no paid-through period.",
				"SUBSCRIPTION_PERIOD_MISSING",
				422,
			);
		}
	}
}
