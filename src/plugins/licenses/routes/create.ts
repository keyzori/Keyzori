import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const createLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:create").post(
		"/licenses",
		{
			body: licenseModel.create,
			response: licenseModel.issued,
			detail: {
				tags: ["License"],
				summary: "create licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:create",
			},
		},
		({ body, operation }) => service.create(body, operation),
	);
