import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";
import { HttpError } from "../../../core/http/HttpError";

export const selfLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "self").get(
		"/licenses/self",
		{
			response: licenseModel.safe,
			detail: {
				tags: ["License"],
				summary: "Read the authenticated license",
				security: [{ bearerAuth: [] }],
			},
		},
		({ operation, request }) => {
			if (new URL(request.url).searchParams.size)
				throw new HttpError("INVALID_REQUEST");
			return service.self(operation);
		},
	);
