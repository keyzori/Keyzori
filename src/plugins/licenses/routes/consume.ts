import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const consumeLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "usage:consume").post(
		"/licenses/consume",
		{
			body: licenseModel.consume,
			response: licenseModel.consumed,
			detail: {
				tags: ["Usage"],
				summary:
					"Atomically consume named counters with a required Idempotency-Key",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "usage:consume",
			},
		},
		({ body, operation }) => service.consume(body, operation),
	);
