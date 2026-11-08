import type { $Groups, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { groupModel } from "../model";

export const disableGroup = (service: $Groups, requests: $Requests) =>
	guard(requests, "groups:disable").post(
		"/groups/disable",
		{
			body: groupModel.disable,
			response: groupModel.bulkResponse,
			detail: {
				tags: ["Groups"],
				security: [{ bearerAuth: [] }],
				description: "Requires groups:disable.",
			},
		},
		({ body, operation }) => service.disable(body, operation),
	);
