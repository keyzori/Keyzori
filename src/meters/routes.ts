import { Elysia } from "elysia";
import type { AdminGuard } from "../shared/adminGuard.ts";
import { idParams } from "../shared/schemas.ts";
import type { MeterService } from "./MeterService.ts";
import { meterBody, meterUpdate, usageQuery } from "./schemas.ts";
import { meterResponse, usageResponse } from "./responses.ts";
import { pageResponse } from "../shared/responses.ts";
const metersResponse = pageResponse(meterResponse);
const usagesResponse = pageResponse(usageResponse);
export function meterRoutes(service: MeterService, guard: AdminGuard) {
	return new Elysia({ prefix: "/admin/meters", detail: guard.config.detail })
		.use(guard)
		.get("/", ({ query }) => service.list(query), {
			query: usageQuery,
			response: metersResponse,
		})
		.post(
			"/",
			({ body, set }) => {
				set.status = 201;
				return service.create(body);
			},
			{ body: meterBody, response: { 201: meterResponse } },
		)
		.get("/:id", ({ params }) => service.get(params.id), {
			params: idParams,
			response: meterResponse,
		})
		.patch(
			"/:id",
			({ params, body }) => service.update(params.id, body.limit),
			{ params: idParams, body: meterUpdate, response: meterResponse },
		);
}
export function usageAdminRoutes(service: MeterService, guard: AdminGuard) {
	return new Elysia({ prefix: "/admin/usage", detail: guard.config.detail })
		.use(guard)
		.get("/", ({ query }) => service.usage(query), {
			query: usageQuery,
			response: usagesResponse,
		});
}
