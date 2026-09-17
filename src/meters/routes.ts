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
			detail: {
				tags: ["Meters"],
				operationId: "listMeters",
				summary: "List license meters",
				description:
					"Browse meters for the required licenseId, optionally narrowed to meterId. Includes current limits and consumed units.",
			},
			query: usageQuery,
			response: metersResponse,
		})
		.post(
			"/",
			({ body, set }) => {
				set.status = 201;
				return service.create(body);
			},
			{
				detail: {
					tags: ["Meters"],
					operationId: "createMeter",
					summary: "Create a meter",
					description:
						"Add a named usage counter to a metered license. Names must be unique within the license. A zero limit permits no consumption.",
				},
				body: meterBody,
				response: { 201: meterResponse },
			},
		)
		.get("/:id", ({ params }) => service.get(params.id), {
			detail: {
				tags: ["Meters"],
				operationId: "getMeter",
				summary: "Get a meter",
				description:
					"Retrieve a meter by its UUID, including its license, name, limit, and consumed units.",
			},
			params: idParams,
			response: meterResponse,
		})
		.patch(
			"/:id",
			({ params, body }) => service.update(params.id, body.limit),
			{
				detail: {
					tags: ["Meters"],
					operationId: "updateMeter",
					summary: "Change a meter limit",
					description:
						"Set the maximum total units. The limit cannot be lower than already consumed usage, and the license must currently be metered.",
				},
				params: idParams,
				body: meterUpdate,
				response: meterResponse,
			},
		);
}
export function usageAdminRoutes(service: MeterService, guard: AdminGuard) {
	return new Elysia({ prefix: "/admin/usage", detail: guard.config.detail })
		.use(guard)
		.get("/", ({ query }) => service.usage(query), {
			detail: {
				tags: ["Usage history"],
				operationId: "listUsage",
				summary: "List usage receipts",
				description:
					"Browse durable usage receipts for the required licenseId, optionally filtered by meterId. Receipts record the totals at the time of consumption.",
			},
			query: usageQuery,
			response: usagesResponse,
		});
}
