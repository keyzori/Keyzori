import type { $Items, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { itemModel } from "../model";

export const deleteItem = (service: $Items, requests: $Requests) =>
	guard(requests, "items:delete").delete(
		"/items",
		{
			body: itemModel.remove,
			response: itemModel.removeResponse,
			detail: {
				tags: ["Items"],
				security: [{ bearerAuth: [] }],
				description: "Requires items:delete and licenses:delete.",
			},
		},
		({ body, operation }) => service.remove(body, operation),
	);
