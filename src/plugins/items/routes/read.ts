import type { $Items, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { itemModel } from "../model";

export const readItem = (service: $Items, requests: $Requests) =>
	guard(requests, "items:read").get(
		"/items",
		{
			query: itemModel.query,
			response: itemModel.readResponse,
			detail: {
				tags: ["Items"],
				security: [{ bearerAuth: [] }],
				description: "Requires items:read.",
			},
		},
		({ request, operation }) =>
			service.read(new URL(request.url).searchParams, operation),
	);
