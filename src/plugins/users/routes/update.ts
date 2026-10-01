import type { $Users, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { userModel } from "../model";

export const updateUser = (service: $Users, requests: $Requests) =>
	guard(requests, "users:update").patch(
		"/users",
		{
			body: userModel.update,
			response: userModel.bulkResponse,
			detail: {
				tags: ["Users"],
				security: [{ bearerAuth: [] }],
				description: "Requires users:update.",
			},
		},
		({ body, operation }) => service.update(body, operation),
	);
