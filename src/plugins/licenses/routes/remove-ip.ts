import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const removeIpLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:update").post(
		"/licenses/ips/remove",
		{
			body: licenseModel.removeIps,
			response: licenseModel.result,
			detail: {
				tags: ["License"],
				summary: "remove-ip licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:update",
			},
		},
		({ body, operation }) => service.removeIps(body, operation),
	);
