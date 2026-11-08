import type { $Groups, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { groupModel } from "../model";

export const enableGroup = (service: $Groups, requests: $Requests) =>
	guard(requests, "groups:enable").post(
		"/groups/enable",
		{
			body: groupModel.enable,
			response: groupModel.bulkResponse,
			detail: {
				tags: ["Groups"],
				security: [{ bearerAuth: [] }],
				description: "Requires groups:enable.",
			},
		},
		({ body, operation }) => service.enable(body, operation),
	);
