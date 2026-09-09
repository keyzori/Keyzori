import type {
	JsonObject,
	StripeSubscriptionLink,
	StripeWebhookEvent,
} from "../entities";

export interface NewStripeSubscriptionLink {
	licenseId: string;
	subscriptionId: string;
	stripeCustomerId: string;
	status: string;
	paidThrough: Date | null;
	cancelAtPeriodEnd: boolean;
	priceId?: string | null;
	billingRevokedAt: Date | null;
	lastSyncedAt: Date | null;
	lastError?: string | null;
}

export type StripeSubscriptionLinkUpdate = Partial<
	Pick<
		StripeSubscriptionLink,
		| "stripeCustomerId"
		| "status"
		| "paidThrough"
		| "cancelAtPeriodEnd"
		| "priceId"
		| "billingRevokedAt"
		| "lastSyncedAt"
		| "lastError"
	>
>;

export interface IStripeSubscriptionRepository {
	withSubscriptionReconciliationLock<T>(
		subscriptionId: string,
		operation: (repository: IStripeSubscriptionRepository) => Promise<T>,
	): Promise<T>;
	createForSubscriptionLicense(
		data: NewStripeSubscriptionLink,
	): Promise<StripeSubscriptionLink | null>;
	findByLicenseId(licenseId: string): Promise<StripeSubscriptionLink | null>;
	findBySubscriptionId(
		subscriptionId: string,
	): Promise<StripeSubscriptionLink | null>;
	updateBySubscriptionId(
		subscriptionId: string,
		data: StripeSubscriptionLinkUpdate,
	): Promise<StripeSubscriptionLink>;
	reconcileForSubscriptionLicense(
		subscriptionId: string,
		data: StripeSubscriptionLinkUpdate,
	): Promise<StripeSubscriptionLink | null>;
	setBillingRevocation(
		subscriptionId: string,
		billingRevokedAt: Date | null,
	): Promise<StripeSubscriptionLink>;
	deleteByLicenseId(licenseId: string): Promise<boolean>;
}

export interface NewStripeWebhookEvent {
	eventId: string;
	type: string;
	objectId?: string | null;
	payload: JsonObject;
	nextAttemptAt?: Date;
}

export interface StripeWebhookEnqueueResult {
	event: StripeWebhookEvent;
	inserted: boolean;
}

export interface IStripeWebhookRepository {
	enqueue(data: NewStripeWebhookEvent): Promise<StripeWebhookEnqueueResult>;
	claimDue(limit: number, now?: Date): Promise<StripeWebhookEvent[]>;
	markProcessed(eventId: string, processedAt?: Date): Promise<void>;
	markFailed(
		eventId: string,
		error: string,
		nextAttemptAt: Date,
	): Promise<void>;
	findById(eventId: string): Promise<StripeWebhookEvent | null>;
}
