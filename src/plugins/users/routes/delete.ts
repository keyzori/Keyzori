import type { $Users, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { userModel } from "../model";

export const deleteUser = (service: $Users, requests: $Requests) =>
	guard(requests, "users:delete").delete(
		"/users",
		{
			body: userModel.remove,
			response: userModel.removeResponse,
			detail: {
				tags: ["Users"],
				security: [{ bearerAuth: [] }],
				description: "Requires users:delete and licenses:delete.",
			},
		},
		({ body, operation }) => service.remove(body, operation),
	);
