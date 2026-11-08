import type { $Groups, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { groupModel } from "../model";

export const createGroup = (service: $Groups, requests: $Requests) =>
	guard(requests, "groups:create").post(
		"/groups",
		{
			body: groupModel.create,
			response: groupModel.singleResponse,
			detail: {
				tags: ["Groups"],
				security: [{ bearerAuth: [] }],
				description: "Requires groups:create.",
			},
		},
		({ body, operation }) => service.create(body, operation),
	);
