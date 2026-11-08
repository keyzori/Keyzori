import { t } from "elysia";
import { guard } from "../../../core/http/guard";
import { httpModel } from "../../../core/http/model";
import { detailQuery } from "../../../core/http/resourceRequest";
import type { $Requests } from "../../../types/application";
import type { UsageHistory } from "../UsageHistory";
import { licenseModel } from "../model";

export const usageHistoryRoutes = (
	service: Pick<UsageHistory, "read" | "lookup">,
	requests: $Requests,
) =>
	guard(requests, "usage:read")
		.get(
			"/usage/operations",
			{
				query: t.Object(
					{ licenseId: httpModel.id },
					{ additionalProperties: false },
				),
				response: licenseModel.receipt,
				detail: {
					tags: ["Usage"],
					security: [{ bearerAuth: [] }],
					"x-required-scope": "usage:read",
				},
			},
			({ query, operation }) => service.lookup(query.licenseId, operation),
		)
		.get(
			"/usage/operations/:id",
			{
				params: t.Object({ id: httpModel.id }),
				response: licenseModel.receipt,
				detail: {
					tags: ["Usage"],
					security: [{ bearerAuth: [] }],
					"x-required-scope": "usage:read",
				},
			},
			({ params, request, operation }) => {
				detailQuery(request, params.id);
				return service.read(params.id, operation);
			},
		);
