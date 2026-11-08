import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const removeHardwareLicense = (
	service: $Licenses,
	requests: $Requests,
) =>
	guard(requests, "devices:remove").post(
		"/licenses/hardware/remove",
		{
			body: licenseModel.removeHardware,
			response: licenseModel.result,
			detail: {
				tags: ["License"],
				summary: "remove-hardware licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "devices:remove",
			},
		},
		({ body, operation }) => service.removeHardware(body, operation),
	);
