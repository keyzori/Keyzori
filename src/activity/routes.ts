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
			query: activityQuery,
			response: activitiesResponse,
		})
		.get("/statistics", ({ query }) => service.stats(query), {
			response: statisticsResponse,
			query: activityQuery,
		})
		.post("/prune", () => service.prune(), {
			body: emptyBody,
			response: pruneResponse,
		});
}
