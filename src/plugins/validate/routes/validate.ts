import { Elysia } from "elysia";
import { validationModel } from "../model";
import type { $Requests, $Validation } from "../../../types/application";
import type { Metrics } from "../../../core/observability/Metrics";

export const validateLicense = (
	service: $Validation,
	requests: $Requests,
	metrics: Metrics,
) =>
	new Elysia({ normalize: false }).post(
		"/validate",
		{
			body: validationModel.body,
			response: validationModel.response,
			detail: {
				tags: ["Validation"],
				summary: "Validate a licence and atomically consume usage",
				security: [],
			},
		},
		async ({ body, request, server }) => {
			const context = await requests.runtime(
				request,
				server?.requestIP(request)?.address ?? null,
			);
			const result = await service.validate(body, context);
			metrics.validation(result.code);
			return result;
		},
	);
