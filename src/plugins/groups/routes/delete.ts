import type { $Groups, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { groupModel } from "../model";

export const deleteGroup = (service: $Groups, requests: $Requests) =>
	guard(requests, "groups:delete").delete(
		"/groups",
		{
			body: groupModel.remove,
			response: groupModel.removeResponse,
			detail: {
				tags: ["Groups"],
				security: [{ bearerAuth: [] }],
				description: "Requires groups:delete and licenses:delete.",
			},
		},
		({ body, operation }) => service.remove(body, operation),
	);
