import type { Environment } from "../../src/shared/Config.ts";

export class StripeConfig {
	readonly secretKey: string;
	readonly webhookSecret: string;
	constructor(env: Environment) {
		if (
			!env.KEYZORI_STRIPE_SECRET_KEY?.match(
				/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/,
			)
		)
			throw new Error(
				"Enabled plugin stripe requires KEYZORI_STRIPE_SECRET_KEY.",
			);
		if (!env.KEYZORI_STRIPE_WEBHOOK_SECRET?.match(/^whsec_[A-Za-z0-9]+$/))
			throw new Error(
				"Enabled plugin stripe requires KEYZORI_STRIPE_WEBHOOK_SECRET.",
			);
		this.secretKey = env.KEYZORI_STRIPE_SECRET_KEY;
		this.webhookSecret = env.KEYZORI_STRIPE_WEBHOOK_SECRET;
	}
}
