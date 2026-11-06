import { t } from "elysia";
import { guard } from "../../../core/http/guard";
import type { $Requests } from "../../../types/application";
import type { HealthService } from "../HealthService";
import { healthProperties } from "./read";

const check = t.Object(
	{
		healthy: t.Boolean(),
		cause: t.Nullable(t.String()),
		durationMs: t.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const readDiagnostics = (
	service: Pick<HealthService, "diagnostics">,
	requests: $Requests,
) =>
	guard(requests, "root").get(
		"/health/diagnostics",
		{
			response: t.Object(
				{
					...healthProperties,
					phase: t.Union([
						t.Literal("configuration"),
						t.Literal("schema"),
						t.Literal("dependencies"),
						t.Literal("publication"),
						t.Literal("serving"),
						t.Literal("draining"),
						t.Literal("failed"),
					]),
					draining: t.Boolean(),
					activeRequests: t.Integer({ minimum: 0 }),
					cause: t.Nullable(t.String()),
					checks: t.Object(
						{ postgresql: check, redis: check },
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
			detail: { tags: ["Operations"], security: [{ bearerAuth: [] }] },
		},
		() => service.diagnostics(),
	);
