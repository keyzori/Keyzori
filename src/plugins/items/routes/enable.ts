import type { $Items, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { itemModel } from "../model";

export const enableItem = (service: $Items, requests: $Requests) =>
	guard(requests, "items:enable").post(
		"/items/enable",
		{
			body: itemModel.enable,
			response: itemModel.bulkResponse,
			detail: {
				tags: ["Items"],
				security: [{ bearerAuth: [] }],
				description: "Requires items:enable.",
			},
		},
		({ body, operation }) => service.enable(body, operation),
	);
