import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const adjustMeterLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:update").post(
		"/licenses/meters/adjust",
		{
			body: licenseModel.adjust,
			response: licenseModel.result,
			detail: {
				tags: ["License"],
				summary: "adjust-meter licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:update",
			},
		},
		({ body, operation }) => service.adjust(body, operation),
	);
