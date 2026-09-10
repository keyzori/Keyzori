import { Elysia } from "elysia";
import type { AdminGuard } from "../shared/adminGuard.ts";
import { idParams, pageQuery } from "../shared/schemas.ts";
import type { CustomerService } from "./CustomerService.ts";
import { customerBody } from "./schemas.ts";
import { customerResponse } from "./responses.ts";
import { pageResponse } from "../shared/responses.ts";

const customersResponse = pageResponse(customerResponse);
export function customerRoutes(service: CustomerService, guard: AdminGuard) {
	return new Elysia({ prefix: "/admin/customers", detail: guard.config.detail })
		.use(guard)
		.get("/", ({ query }) => service.list(query), {
			query: pageQuery,
			response: customersResponse,
		})
		.post(
			"/",
			({ body, set }) => {
				set.status = 201;
				return service.create(body);
			},
			{ body: customerBody, response: { 201: customerResponse } },
		)
		.get("/:id", ({ params }) => service.get(params.id), {
			params: idParams,
			response: customerResponse,
		})
		.put("/:id", ({ params, body }) => service.update(params.id, body), {
			params: idParams,
			body: customerBody,
			response: customerResponse,
		})
		.delete("/:id", ({ params }) => service.delete(params.id), {
			params: idParams,
			response: customerResponse,
		});
}
