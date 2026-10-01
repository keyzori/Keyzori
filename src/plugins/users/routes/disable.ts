import type { $Users, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { userModel } from "../model";

export const disableUser = (service: $Users, requests: $Requests) =>
	guard(requests, "users:disable").post(
		"/users/disable",
		{
			body: userModel.disable,
			response: userModel.bulkResponse,
			detail: {
				tags: ["Users"],
				security: [{ bearerAuth: [] }],
				description: "Requires users:disable.",
			},
		},
		({ body, operation }) => service.disable(body, operation),
	);
