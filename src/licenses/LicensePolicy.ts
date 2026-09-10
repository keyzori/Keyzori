import type { LicenseDetails } from "./LicenseRepository.ts";
import type { licenseConfig } from "./schemas.ts";
import { AppError } from "../shared/errors.ts";

export class LicensePolicy {
	assertActive(license: LicenseDetails, now = Date.now()) {
		if (license.blocks.length)
			throw new AppError("LICENSE_BLOCKED", "License access is blocked.", 403);
		if (
			license.type === "subscription" &&
			(!license.subscription || license.subscription.expiresAt.getTime() <= now)
		)
			throw new AppError("LICENSE_EXPIRED", "License has expired.", 403);
		if (
			license.type === "trial" &&
			(!license.trial ||
				(license.trial.expiresAt && license.trial.expiresAt.getTime() <= now))
		)
			throw new AppError("LICENSE_EXPIRED", "Trial has expired.", 403);
	}
	validateConfig(config: typeof licenseConfig.infer) {
		if (
			config.type === "subscription" &&
			new Date(config.expiresAt).getTime() <= Date.now()
		)
			throw new AppError("INVALID_EXPIRY", "Expiry must be in the future.");
	}
}
