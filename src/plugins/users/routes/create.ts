import type { $Users, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { userModel } from "../model";

export const createUser = (service: $Users, requests: $Requests) =>
	guard(requests, "users:create").post(
		"/users",
		{
			body: userModel.create,
			response: userModel.singleResponse,
			detail: {
				tags: ["Users"],
				security: [{ bearerAuth: [] }],
				description: "Requires users:create.",
			},
		},
		({ body, operation }) => service.create(body, operation),
	);
