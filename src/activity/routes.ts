import { Elysia } from "elysia";
import type { AdminGuard } from "../shared/adminGuard.ts";
import { emptyBody } from "../shared/schemas.ts";
import type { ActivityService } from "./ActivityService.ts";
import { activityQuery } from "./schemas.ts";
import {
	activityResponse,
	statisticsResponse,
	pruneResponse,
} from "./responses.ts";
import { pageResponse } from "../shared/responses.ts";

const activitiesResponse = pageResponse(activityResponse);
export function activityRoutes(service: ActivityService, guard: AdminGuard) {
	return new Elysia({ prefix: "/admin/activity", detail: guard.config.detail })
		.use(guard)
		.get("/", ({ query }) => service.list(query), {
			detail: {
				tags: ["Activity"],
				operationId: "listActivity",
				summary: "List activity",
				description:
					"Browse audit events filtered by license, customer, action, source, or ISO date range. The start date must not be later than the end date.",
			},
			query: activityQuery,
			response: activitiesResponse,
		})
		.get("/statistics", ({ query }) => service.stats(query), {
			detail: {
				tags: ["Activity"],
				operationId: "getActivityStatistics",
				summary: "Get activity statistics",
				description:
					"Count matching events by action and return the configured retention period. Date and entity filters match the activity listing; pagination does not limit these aggregate counts.",
			},
			response: statisticsResponse,
			query: activityQuery,
		})
		.post("/prune", () => service.prune(), {
			detail: {
				tags: ["Activity"],
				operationId: "pruneActivity",
				summary: "Prune expired activity",
				description:
					"Permanently delete audit events older than the configured retention period and return the deleted count. Send an empty JSON object.",
			},
			body: emptyBody,
			response: pruneResponse,
		});
}
