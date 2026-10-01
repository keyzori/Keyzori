import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const rotateLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:rotate").post(
		"/licenses/rotate",
		{
			body: licenseModel.rotate,
			response: licenseModel.rotated,
			detail: {
				tags: ["License"],
				summary: "rotate licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:rotate",
			},
		},
		({ body, operation }) => service.rotate(body, operation),
	);
