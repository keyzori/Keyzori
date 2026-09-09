import type { EffectiveLicenseStatus, License } from "./entities";

export function deriveLicenseStatus(
	license: Pick<
		License,
		| "type"
		| "expiresAt"
		| "trialDurationMinutes"
		| "trialStartedAt"
		| "manualRevokedAt"
		| "billingRevokedAt"
	>,
	now = new Date(),
): EffectiveLicenseStatus {
	if (license.manualRevokedAt) {
		return { status: "revoked", reason: "manual_revocation" };
	}
	if (license.billingRevokedAt) {
		return { status: "revoked", reason: "billing_revocation" };
	}
	if (
		license.type === "subscription" &&
		(!license.expiresAt || license.expiresAt.getTime() <= now.getTime())
	) {
		return { status: "expired", reason: "subscription_expired" };
	}
	if (
		license.type === "trial" &&
		license.trialStartedAt &&
		now.getTime() >=
			license.trialStartedAt.getTime() + license.trialDurationMinutes * 60_000
	) {
		return { status: "expired", reason: "trial_expired" };
	}
	return { status: "active", reason: null };
}
