import type { $Groups, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { groupModel } from "../model";
import { t } from "elysia";
import { httpModel } from "../../../core/http/model";
import {
	collectionQuery,
	detailQuery,
} from "../../../core/http/resourceRequest";

export const readGroup = (service: $Groups, requests: $Requests) =>
	guard(requests, "groups:read")
		.get(
			"/groups",
			{
				query: groupModel.query,
				response: groupModel.readResponse.anyOf[1],
				detail: {
					tags: ["Groups"],
					security: [{ bearerAuth: [] }],
					description: "Requires groups:read.",
				},
			},
			async ({ request, operation }) => {
				const result = await service.read(collectionQuery(request), operation);
				if (
					!Array.isArray(result.data) ||
					result.pageLimit === undefined ||
					result.nextCursor === undefined
				)
					throw new Error("Expected group collection");
				return {
					data: result.data,
					pageLimit: result.pageLimit,
					nextCursor: result.nextCursor,
				};
			},
		)
		.get(
			"/groups/:id",
			{
				params: t.Object({ id: httpModel.id }),
				response: groupModel.singleResponse,
				detail: {
					tags: ["Groups"],
					security: [{ bearerAuth: [] }],
					"x-required-scope": "groups:read",
				},
			},
			async ({ request, params, operation }) => {
				const result = await service.read(
					detailQuery(request, params.id),
					operation,
				);
				if ("nextCursor" in result) throw new Error("Expected group detail");
				return result;
			},
		);
