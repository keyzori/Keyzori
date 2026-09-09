export const LICENSE_TYPES = [
	"lifetime",
	"subscription",
	"metered",
	"trial",
] as const;

export type LicenseType = (typeof LICENSE_TYPES)[number];

export interface JsonObject {
	[key: string]: JsonValue;
}

export interface JsonArray extends Array<JsonValue> {}

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonObject
	| JsonArray;

export interface Customer {
	id: string;
	email: string;
	name: string;
	metadata: JsonObject;
	createdAt: Date;
	updatedAt: Date;
}

export interface SubscriptionTypeDraft extends JsonObject {
	expiresAt: string | null;
}

export interface TrialTypeDraft extends JsonObject {
	durationMinutes: number;
}

export interface MeteredTypeDraft extends JsonObject {
	meterNames: string[];
}

export interface LicenseTypeDrafts {
	lifetime?: JsonObject;
	subscription?: SubscriptionTypeDraft;
	metered?: MeteredTypeDraft;
	trial?: TrialTypeDraft;
}

export interface License {
	id: string;
	keyPrefix: string;
	customerId: string;
	type: LicenseType;
	maxIps: number;
	maxDevices: number;
	maxSessions: number;
	sessionRevision: number;
	trialDurationMinutes: number;
	trialStartedAt: Date | null;
	metadata: JsonObject;
	expiresAt: Date | null;
	typeDrafts: LicenseTypeDrafts;
	manualRevokedAt: Date | null;
	manualRevocationReason: string | null;
	billingRevokedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

/** A license secret is intentionally exposed only by create and rotation calls. */
export interface RevealedLicense extends License {
	licenseKey: string;
}

export interface NewLicenseMeter {
	name: string;
	balance: number;
	reason: string;
}

export interface NewLicense {
	licenseKey: string;
	customerId: string;
	type: LicenseType;
	maxIps: number;
	maxDevices: number;
	maxSessions: number;
	trialDurationMinutes: number;
	trialStartedAt: Date | null;
	metadata: JsonObject;
	expiresAt: Date | null;
	typeDrafts: LicenseTypeDrafts;
	meters: NewLicenseMeter[];
}

export type LicenseStatus = "active" | "expired" | "revoked";

export type LicenseStatusReason =
	| "manual_revocation"
	| "billing_revocation"
	| "subscription_expired"
	| "trial_expired"
	| null;

export interface EffectiveLicenseStatus {
	status: LicenseStatus;
	reason: LicenseStatusReason;
}

export interface IpAllowlistEntry {
	id: string;
	licenseId: string;
	ip: string;
	createdAt: Date;
}

export interface DeviceAllowlistEntry {
	id: string;
	licenseId: string;
	deviceId: string;
	createdAt: Date;
}

export interface RegisteredDevice {
	id: string;
	licenseId: string;
	ip: string;
	deviceId: string;
	createdAt: Date;
	lastSeenAt: Date;
}

export type MeterLedgerKind =
	| "create"
	| "consume"
	| "top_up"
	| "adjustment"
	| "archive";

export interface LicenseMeter {
	id: string;
	licenseId: string;
	name: string;
	balance: number;
	archivedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface UsageLedgerEntry {
	id: string;
	licenseId: string;
	meterId: string;
	eventId: string;
	kind: MeterLedgerKind;
	delta: number;
	balanceBefore: number;
	balanceAfter: number;
	reason: string | null;
	createdAt: Date;
}

export const ACTIVITY_EVENT_TYPES = [
	"customer.created",
	"customer.updated",
	"customer.deleted",
	"license.created",
	"license.updated",
	"license.type_changed",
	"license.deleted",
	"license.revoked",
	"license.restored",
	"license.key_rotated",
	"license.activation_attempted",
	"license.activation_succeeded",
	"license.activation_rejected",
	"license.heartbeat",
	"license.deactivated",
	"meter.created",
	"meter.archived",
	"meter.adjusted",
	"usage.consumed",
	"usage.rejected",
	"stripe.linked",
	"stripe.unlinked",
	"stripe.synchronized",
	"stripe.webhook_failed",
] as const;

export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];
export type ActivitySource = "operator" | "client" | "stripe" | "system";
export type ActivityOutcome = "success" | "rejected" | "error";

export interface ActivityEvent {
	id: string;
	type: ActivityEventType;
	source: ActivitySource;
	outcome: ActivityOutcome;
	reason: string | null;
	licenseId: string | null;
	customerId: string | null;
	keyPrefix: string | null;
	ip: string | null;
	deviceId: string | null;
	details: JsonObject;
	createdAt: Date;
}

export interface NewActivityEvent {
	type: ActivityEventType;
	source: ActivitySource;
	outcome?: ActivityOutcome;
	reason?: string | null;
	licenseId?: string | null;
	customerId?: string | null;
	keyPrefix?: string | null;
	ip?: string | null;
	deviceId?: string | null;
	details?: JsonObject;
	createdAt?: Date;
}

export type ActivityScope = "global" | "customer" | "license";

export interface ActivityTotal {
	scope: ActivityScope;
	scopeId: string;
	type: ActivityEventType;
	count: number;
}

export interface ActivityMinuteBucket extends ActivityTotal {
	minute: Date;
}

export interface StripeSubscriptionLink {
	id: string;
	licenseId: string;
	subscriptionId: string;
	stripeCustomerId: string;
	status: string;
	paidThrough: Date | null;
	cancelAtPeriodEnd: boolean;
	priceId: string | null;
	billingRevokedAt: Date | null;
	lastSyncedAt: Date | null;
	lastError: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export type StripeWebhookStatus =
	| "pending"
	| "processing"
	| "processed"
	| "failed";

export interface StripeWebhookEvent {
	eventId: string;
	type: string;
	objectId: string | null;
	status: StripeWebhookStatus;
	attempts: number;
	nextAttemptAt: Date;
	payload: JsonObject;
	lastError: string | null;
	receivedAt: Date;
	processedAt: Date | null;
}
