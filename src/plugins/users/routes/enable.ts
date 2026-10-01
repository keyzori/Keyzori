import type { $Users, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { userModel } from "../model";

export const enableUser = (service: $Users, requests: $Requests) =>
	guard(requests, "users:enable").post(
		"/users/enable",
		{
			body: userModel.enable,
			response: userModel.bulkResponse,
			detail: {
				tags: ["Users"],
				security: [{ bearerAuth: [] }],
				description: "Requires users:enable.",
			},
		},
		({ body, operation }) => service.enable(body, operation),
	);
