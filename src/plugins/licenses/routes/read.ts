import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const readLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:read").get(
		"/licenses",
		{
			response: licenseModel.read,
			detail: {
				tags: ["License"],
				summary: "read licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:read",
			},
		},
		({ request, operation }) =>
			service.read(new URL(request.url).searchParams, operation),
	);
