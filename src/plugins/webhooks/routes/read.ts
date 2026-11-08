import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const readWebhook = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:read")
		.get(
			"/webhooks",
			{
				query: webhookModel.query,
				response: webhookModel.listResponse,
				detail: {
					tags: ["Webhooks"],
					security: [{ bearerAuth: [] }],
					description: "Requires webhooks:read.",
				},
			},
			async ({ request, operation }) => {
				const result = await service.read(
					new URL(request.url).searchParams,
					operation,
				);
				if (!Array.isArray(result.data) || typeof result.pageLimit !== "number")
					throw new Error("Expected webhook collection");
				return {
					data: result.data,
					nextCursor: result.nextCursor ?? null,
					pageLimit: result.pageLimit,
				};
			},
		)
		.get(
			"/webhooks/:id",
			{
				params: webhookModel.id,
				query: webhookModel.detailQuery,
				response: webhookModel.detailResponse,
				detail: {
					tags: ["Webhooks"],
					security: [{ bearerAuth: [] }],
					description:
						"Read one endpoint with current ownership, event and group authority.",
				},
			},
			async ({ params, operation }) => {
				const result = await service.read(
					new URLSearchParams({ id: params.id }),
					operation,
				);
				if (Array.isArray(result.data))
					throw new Error("Expected webhook detail");
				return { data: result.data };
			},
		);
