import type { $Groups, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { groupModel } from "../model";

export const updateGroup = (service: $Groups, requests: $Requests) =>
	guard(requests, "groups:update").patch(
		"/groups",
		{
			body: groupModel.update,
			response: groupModel.bulkResponse,
			detail: {
				tags: ["Groups"],
				security: [{ bearerAuth: [] }],
				description: "Requires groups:update.",
			},
		},
		({ body, operation }) => service.update(body, operation),
	);
