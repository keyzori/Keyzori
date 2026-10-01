import { Elysia } from "elysia";
import { validateLicense } from "./routes/validate";
import type { $Requests, $Validation } from "../../types/application";
import type { Metrics } from "../../core/observability/Metrics";

export const validationRoutes = (
	service: $Validation,
	requests: $Requests,
	metrics: Metrics,
) =>
	new Elysia({ normalize: false })
		.use(validateLicense(service, requests, metrics))
		.options(
			"/validate",
			{ detail: { hide: true } },
			() => new Response(null, { status: 204 }),
		);
