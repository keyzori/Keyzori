import type { $Items, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { itemModel } from "../model";

export const createItem = (service: $Items, requests: $Requests) =>
	guard(requests, "items:create").post(
		"/items",
		{
			body: itemModel.create,
			response: itemModel.singleResponse,
			detail: {
				tags: ["Items"],
				security: [{ bearerAuth: [] }],
				description: "Requires items:create.",
			},
		},
		({ body, operation }) => service.create(body, operation),
	);
