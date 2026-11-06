import type { $ApiKeys, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { apiKeyModel } from "../model";
import { t } from "elysia";
import { httpModel } from "../../../core/http/model";
import {
	collectionQuery,
	detailQuery,
} from "../../../core/http/resourceRequest";

export const readApiKey = (service: $ApiKeys, requests: $Requests) =>
	guard(requests, "root")
		.get(
			"/api-keys",
			{
				response: apiKeyModel.read.anyOf[1],
				detail: {
					tags: ["ApiKey"],
					summary: "read api-keys",
					security: [{ bearerAuth: [] }],
					"x-required-scope": "root",
				},
			},
			async ({ request, operation }) => {
				const result = await service.read(collectionQuery(request), operation);
				if (
					!Array.isArray(result.data) ||
					result.pageLimit === undefined ||
					result.nextCursor === undefined
				)
					throw new Error("Expected API-key collection");
				return {
					data: result.data,
					pageLimit: result.pageLimit,
					nextCursor: result.nextCursor,
				};
			},
		)
		.get(
			"/api-keys/:id",
			{
				params: t.Object({ id: httpModel.id }),
				response: apiKeyModel.read.anyOf[0],
				detail: {
					tags: ["ApiKey"],
					security: [{ bearerAuth: [] }],
					"x-required-scope": "root",
				},
			},
			async ({ request, params, operation }) => {
				const result = await service.read(
					detailQuery(request, params.id),
					operation,
				);
				if ("nextCursor" in result) throw new Error("Expected API-key detail");
				return result;
			},
		);
