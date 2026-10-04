import type { $Items, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { itemModel } from "../model";

export const disableItem = (service: $Items, requests: $Requests) =>
	guard(requests, "items:disable").post(
		"/items/disable",
		{
			body: itemModel.disable,
			response: itemModel.bulkResponse,
			detail: {
				tags: ["Items"],
				security: [{ bearerAuth: [] }],
				description: "Requires items:disable.",
			},
		},
		({ body, operation }) => service.disable(body, operation),
	);
