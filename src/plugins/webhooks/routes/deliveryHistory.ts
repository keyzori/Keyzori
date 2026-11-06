import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const deliveryHistoryWebhook = (
	service: $Webhooks,
	requests: $Requests,
) =>
	guard(requests, "webhooks:read")
		.get(
			"/webhooks/deliveries",
			{
				query: webhookModel.historyQuery,
				response: webhookModel.historyListResponse,
				detail: {
					tags: ["Webhooks"],
					security: [{ bearerAuth: [] }],
					description: "Requires webhooks:read.",
				},
			},
			async ({ request, operation }) => {
				const result = await service.deliveryHistory(
					new URL(request.url).searchParams,
					operation,
				);
				if (!Array.isArray(result.data) || typeof result.pageLimit !== "number")
					throw new Error("Expected webhook delivery collection");
				return {
					data: result.data,
					nextCursor: result.nextCursor ?? null,
					pageLimit: result.pageLimit,
				};
			},
		)
		.get(
			"/webhooks/deliveries/:id",
			{
				params: webhookModel.id,
				query: webhookModel.detailQuery,
				response: webhookModel.historyDetailResponse,
				detail: {
					tags: ["Webhooks"],
					security: [{ bearerAuth: [] }],
					description:
						"Read one delivery with current ownership, event and group authority.",
				},
			},
			async ({ params, operation }) => {
				const result = await service.deliveryHistory(
					new URLSearchParams({ id: params.id }),
					operation,
				);
				if (Array.isArray(result.data))
					throw new Error("Expected webhook delivery detail");
				return { data: result.data };
			},
		);
