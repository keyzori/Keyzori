import { Elysia, t } from "elysia";
import type { $Requests } from "../../types/application";
import type { HealthService } from "./HealthService";
import { readHealth } from "./routes/read";
import { readDiagnostics } from "./routes/diagnostics";

export const healthRoutes = (
	service: Pick<HealthService, "status" | "diagnostics">,
	requests: $Requests,
) =>
	new Elysia({ normalize: false })
		.get(
			"/live",
			{
				response: t.Object(
					{ alive: t.Literal(true) },
					{ additionalProperties: false },
				),
				detail: { tags: ["Operations"], security: [] },
			},
			() => ({
				alive: true as const,
			}),
		)
		.use(readHealth(service))
		.use(readDiagnostics(service, requests));
