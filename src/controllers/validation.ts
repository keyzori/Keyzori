import { t } from "elysia";
import { MAX_LICENSE_LIMIT } from "../domain/licenseLimits";

export const LicenseTypeSchema = t.Union([
	t.Literal("lifetime"),
	t.Literal("subscription"),
	t.Literal("metered"),
	t.Literal("trial"),
]);

export const JsonObjectSchema = t.Record(t.String(), t.Unknown(), {
	description: "Application-defined JSON metadata.",
});

export const ErrorResponseSchema = t.Object({
	error: t.String(),
	code: t.String(),
});

export const SuccessResponseSchema = t.Object({ success: t.Literal(true) });

const DeviceIdSchema = t.String({ minLength: 1, maxLength: 128 });
const SessionTokenSchema = t.String({ minLength: 32, maxLength: 512 });
const MeterNameSchema = t.String({ minLength: 1, maxLength: 128 });
const EventIdSchema = t.String({ minLength: 1, maxLength: 128 });
const ResourceIdSchema = t.String({ minLength: 1, maxLength: 128 });
const OperatorReasonSchema = t.String({ minLength: 1, maxLength: 500 });
const LimitSchema = t.Integer({ minimum: 0, maximum: MAX_LICENSE_LIMIT });

export const ActivateInputSchema = t.Object(
	{
		licenseKey: t.String({ minLength: 1, maxLength: 128 }),
		deviceId: DeviceIdSchema,
	},
	{ additionalProperties: false },
);

export const SessionInputSchema = t.Object(
	{
		sessionToken: SessionTokenSchema,
		deviceId: DeviceIdSchema,
	},
	{ additionalProperties: false },
);

export const UsageInputSchema = t.Object(
	{
		sessionToken: SessionTokenSchema,
		deviceId: DeviceIdSchema,
		meter: MeterNameSchema,
		units: t.Integer({ minimum: 1, maximum: MAX_LICENSE_LIMIT }),
		eventId: EventIdSchema,
	},
	{ additionalProperties: false },
);

export const LicenseSessionResponseSchema = t.Object({
	success: t.Literal(true),
	licenseType: LicenseTypeSchema,
	metadata: JsonObjectSchema,
	sessionToken: SessionTokenSchema,
	sessionTtlSeconds: t.Integer({ minimum: 1, maximum: 86_400 }),
});

export const UsageResponseSchema = t.Object({
	success: t.Literal(true),
	meter: MeterNameSchema,
	units: t.Integer({ minimum: 1, maximum: MAX_LICENSE_LIMIT }),
	eventId: EventIdSchema,
	remaining: LimitSchema,
});

export const CustomerInputSchema = t.Object(
	{
		email: t.String({ format: "email", maxLength: 254 }),
		name: t.String({ minLength: 1, maxLength: 200 }),
		metadata: t.Optional(JsonObjectSchema),
	},
	{ additionalProperties: false },
);

export const CustomerPatchSchema = t.Object(
	{
		email: t.Optional(t.String({ format: "email", maxLength: 254 })),
		name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
		metadata: t.Optional(JsonObjectSchema),
	},
	{ minProperties: 1, additionalProperties: false },
);

export const CustomerResponseSchema = t.Object({
	id: ResourceIdSchema,
	email: t.String({ format: "email" }),
	name: t.String(),
	metadata: JsonObjectSchema,
	createdAt: t.Date(),
	updatedAt: t.Date(),
});

export const NewMeterInputSchema = t.Object(
	{
		name: MeterNameSchema,
		balance: LimitSchema,
		reason: OperatorReasonSchema,
	},
	{ additionalProperties: false },
);

export const LicenseInputSchema = t.Object(
	{
		customerId: ResourceIdSchema,
		type: LicenseTypeSchema,
		maxIps: t.Optional(LimitSchema),
		maxDevices: t.Optional(LimitSchema),
		maxSessions: t.Optional(LimitSchema),
		trialDurationMinutes: t.Optional(LimitSchema),
		metadata: t.Optional(JsonObjectSchema),
		expiresAt: t.Optional(t.String({ format: "date-time" })),
		meters: t.Optional(t.Array(NewMeterInputSchema, { maxItems: 100 })),
	},
	{ additionalProperties: false },
);

export const LicensePatchSchema = t.Object(
	{
		customerId: t.Optional(ResourceIdSchema),
		type: t.Optional(LicenseTypeSchema),
		maxIps: t.Optional(LimitSchema),
		maxDevices: t.Optional(LimitSchema),
		maxSessions: t.Optional(LimitSchema),
		trialDurationMinutes: t.Optional(LimitSchema),
		metadata: t.Optional(JsonObjectSchema),
		meters: t.Optional(t.Array(NewMeterInputSchema, { maxItems: 100 })),
		expiresAt: t.Optional(
			t.Union([t.String({ format: "date-time" }), t.Null()]),
		),
		confirmStripeUnlink: t.Optional(t.Boolean()),
	},
	{ minProperties: 1, additionalProperties: false },
);

export const EffectiveStatusSchema = t.Object({
	status: t.Union([
		t.Literal("active"),
		t.Literal("expired"),
		t.Literal("revoked"),
	]),
	reason: t.Union([
		t.Literal("manual_revocation"),
		t.Literal("billing_revocation"),
		t.Literal("subscription_expired"),
		t.Literal("trial_expired"),
		t.Null(),
	]),
});

export const LicenseTypeDraftsSchema = t.Object({
	lifetime: t.Optional(JsonObjectSchema),
	subscription: t.Optional(
		t.Object({ expiresAt: t.Union([t.String(), t.Null()]) }),
	),
	metered: t.Optional(t.Object({ meterNames: t.Array(t.String()) })),
	trial: t.Optional(t.Object({ durationMinutes: LimitSchema })),
});

export const LicenseResponseSchema = t.Object({
	id: ResourceIdSchema,
	keyPrefix: t.String(),
	customerId: ResourceIdSchema,
	type: LicenseTypeSchema,
	maxIps: LimitSchema,
	maxDevices: LimitSchema,
	maxSessions: LimitSchema,
	trialDurationMinutes: LimitSchema,
	trialStartedAt: t.Nullable(t.Date()),
	metadata: JsonObjectSchema,
	expiresAt: t.Nullable(t.Date()),
	typeDrafts: LicenseTypeDraftsSchema,
	manualRevokedAt: t.Nullable(t.Date()),
	manualRevocationReason: t.Nullable(t.String()),
	billingRevokedAt: t.Nullable(t.Date()),
	status: EffectiveStatusSchema,
	createdAt: t.Date(),
	updatedAt: t.Date(),
});

export const CreatedLicenseResponseSchema = t.Composite([
	LicenseResponseSchema,
	t.Object({ licenseKey: t.String({ minLength: 1, maxLength: 128 }) }),
]);

export const RevokeInputSchema = t.Object(
	{ reason: OperatorReasonSchema },
	{ additionalProperties: false },
);
export const ConfirmInputSchema = t.Object(
	{ confirm: t.Literal(true) },
	{ additionalProperties: false },
);

export const IpAllowlistInputSchema = t.Object(
	{
		ip: t.String({ minLength: 2, maxLength: 45 }),
	},
	{ additionalProperties: false },
);

export const DeviceAllowlistInputSchema = t.Object(
	{
		deviceId: DeviceIdSchema,
	},
	{ additionalProperties: false },
);

export const MeterAdjustmentInputSchema = t.Object(
	{
		delta: t.Integer({
			minimum: -MAX_LICENSE_LIMIT,
			maximum: MAX_LICENSE_LIMIT,
		}),
		reason: OperatorReasonSchema,
	},
	{ additionalProperties: false },
);

export const MeterTopUpInputSchema = t.Object(
	{
		units: t.Integer({ minimum: 1, maximum: MAX_LICENSE_LIMIT }),
		reason: OperatorReasonSchema,
	},
	{ additionalProperties: false },
);

export const StripeLinkInputSchema = t.Object(
	{
		subscriptionId: t.String({
			minLength: 5,
			maxLength: 255,
			pattern: "^sub_[A-Za-z0-9_]+$",
		}),
	},
	{ additionalProperties: false },
);

export const LicenseMeterResponseSchema = t.Object({
	id: ResourceIdSchema,
	licenseId: ResourceIdSchema,
	name: MeterNameSchema,
	balance: LimitSchema,
	archivedAt: t.Nullable(t.Date()),
	createdAt: t.Date(),
	updatedAt: t.Date(),
});

export const UsageLedgerResponseSchema = t.Object({
	id: ResourceIdSchema,
	licenseId: ResourceIdSchema,
	meterId: ResourceIdSchema,
	eventId: EventIdSchema,
	kind: t.Union([
		t.Literal("create"),
		t.Literal("consume"),
		t.Literal("top_up"),
		t.Literal("adjustment"),
		t.Literal("archive"),
	]),
	delta: t.Integer(),
	balanceBefore: LimitSchema,
	balanceAfter: LimitSchema,
	reason: t.Nullable(t.String()),
	createdAt: t.Date(),
});

export const AccessResponseSchema = t.Object({
	allowedIps: t.Array(
		t.Object({
			id: ResourceIdSchema,
			licenseId: ResourceIdSchema,
			ip: t.String(),
			createdAt: t.Date(),
		}),
	),
	allowedDevices: t.Array(
		t.Object({
			id: ResourceIdSchema,
			licenseId: ResourceIdSchema,
			deviceId: t.String(),
			createdAt: t.Date(),
		}),
	),
	registeredDevices: t.Array(
		t.Object({
			id: ResourceIdSchema,
			licenseId: ResourceIdSchema,
			ip: t.String(),
			deviceId: t.String(),
			createdAt: t.Date(),
			lastSeenAt: t.Date(),
		}),
	),
	attemptedIps: t.Array(
		t.Object({
			value: t.String(),
			attemptCount: t.Integer({ minimum: 0 }),
			firstAttemptedAt: t.Date(),
			lastAttemptedAt: t.Date(),
		}),
	),
	attemptedDevices: t.Array(
		t.Object({
			value: t.String(),
			attemptCount: t.Integer({ minimum: 0 }),
			firstAttemptedAt: t.Date(),
			lastAttemptedAt: t.Date(),
		}),
	),
});
