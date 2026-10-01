import type { $Users, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { userModel } from "../model";

export const readUser = (service: $Users, requests: $Requests) =>
	guard(requests, "users:read").get(
		"/users",
		{
			query: userModel.query,
			response: userModel.readResponse,
			detail: {
				tags: ["Users"],
				security: [{ bearerAuth: [] }],
				description: "Requires users:read.",
			},
		},
		({ request, operation }) =>
			service.read(new URL(request.url).searchParams, operation),
	);
