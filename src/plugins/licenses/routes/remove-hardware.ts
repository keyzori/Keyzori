import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const removeHardwareLicense = (
	service: $Licenses,
	requests: $Requests,
) =>
	guard(requests, "licenses:update").post(
		"/licenses/hardware/remove",
		{
			body: licenseModel.removeHardware,
			response: licenseModel.result,
			detail: {
				tags: ["License"],
				summary: "remove-hardware licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:update",
			},
		},
		({ body, operation }) => service.removeHardware(body, operation),
	);
