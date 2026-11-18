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
					webhookQueue: t.Nullable(
						t.Object(
							{
								pending: t.Integer({ minimum: 0 }),
								claimed: t.Integer({ minimum: 0 }),
								oldestSeconds: t.Number({ minimum: 0 }),
								sampleLimit: t.Integer({ minimum: 1 }),
								observedAt: t.String({ format: "date-time" }),
								ageMs: t.Integer({ minimum: 0 }),
							},
							{ additionalProperties: false },
						),
					),
					checks: t.Object(
						{ postgresql: check, redis: check },
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
			detail: { tags: ["Operations"], security: [{ bearerAuth: [] }] },
		},
		({ operation }) => service.diagnostics(operation.deadlineAt),
	);
