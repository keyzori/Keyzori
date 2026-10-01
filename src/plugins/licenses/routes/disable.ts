import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const disableLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:disable").post(
		"/licenses/disable",
		{
			body: licenseModel.action,
			response: licenseModel.result,
			detail: {
				tags: ["License"],
				summary: "disable licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:disable",
			},
		},
		({ body, operation }) => service.disable(body, operation),
	);
