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
			detail: {
				tags: ["Customers"],
				operationId: "listCustomers",
				summary: "List customers",
				description:
					"Browse customer records using limit and offset. Emails are stored in lowercase; metadata is returned with sensitive values redacted.",
			},
			query: pageQuery,
			response: customersResponse,
		})
		.post(
			"/",
			({ body, set }) => {
				set.status = 201;
				return service.create(body);
			},
			{
				detail: {
					tags: ["Customers"],
					operationId: "createCustomer",
					summary: "Create a customer",
					description:
						"Create the owner of one or more licenses. Email addresses must be unique. Metadata defaults to an empty object.",
				},
				body: customerBody,
				response: { 201: customerResponse },
			},
		)
		.get("/:id", ({ params }) => service.get(params.id), {
			detail: {
				tags: ["Customers"],
				operationId: "getCustomer",
				summary: "Get a customer",
				description:
					"Retrieve a customer by UUID. Returns 404 when the customer does not exist.",
			},
			params: idParams,
			response: customerResponse,
		})
		.put("/:id", ({ params, body }) => service.update(params.id, body), {
			detail: {
				tags: ["Customers"],
				operationId: "replaceCustomer",
				summary: "Replace customer details",
				description:
					"Replace the name, email, and metadata. Omitting metadata resets it to an empty object; this is a full replacement.",
			},
			params: idParams,
			body: customerBody,
			response: customerResponse,
		})
		.delete("/:id", ({ params }) => service.delete(params.id), {
			detail: {
				tags: ["Customers"],
				operationId: "deleteCustomer",
				summary: "Delete a customer",
				description:
					"Delete a customer and return the deleted record. Customers still referenced by licenses cannot be deleted and return 409.",
			},
			params: idParams,
			response: customerResponse,
		});
}
