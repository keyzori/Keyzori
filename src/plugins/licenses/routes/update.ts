import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const updateLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:update").patch(
		"/licenses",
		{
			body: licenseModel.update,
			response: licenseModel.result,
			detail: {
				tags: ["License"],
				summary: "update licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:update",
			},
		},
		({ body, operation }) => service.update(body, operation),
	);
