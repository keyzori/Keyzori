import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const enableLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:enable").post(
		"/licenses/enable",
		{
			body: licenseModel.action,
			response: licenseModel.result,
			detail: {
				tags: ["License"],
				summary: "enable licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:enable",
			},
		},
		({ body, operation }) => service.enable(body, operation),
	);
