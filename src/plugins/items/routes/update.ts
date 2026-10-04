import type { $Items, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { itemModel } from "../model";

export const updateItem = (service: $Items, requests: $Requests) =>
	guard(requests, "items:update").patch(
		"/items",
		{
			body: itemModel.update,
			response: itemModel.bulkResponse,
			detail: {
				tags: ["Items"],
				security: [{ bearerAuth: [] }],
				description: "Requires items:update.",
			},
		},
		({ body, operation }) => service.update(body, operation),
	);
