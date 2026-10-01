import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const deleteLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:delete").delete(
		"/licenses",
		{
			body: licenseModel.delete,
			response: licenseModel.result,
			detail: {
				tags: ["License"],
				summary: "delete licenses",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "licenses:delete",
			},
		},
		({ body, operation }) => service.delete(body, operation),
	);
