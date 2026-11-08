import type { $Users, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { userModel } from "../model";
import { t } from "elysia";
import { httpModel } from "../../../core/http/model";
import {
	collectionQuery,
	detailQuery,
} from "../../../core/http/resourceRequest";

export const readUser = (service: $Users, requests: $Requests) =>
	guard(requests, "users:read")
		.get(
			"/users",
			{
				query: userModel.query,
				response: userModel.readResponse.anyOf[1],
				detail: {
					tags: ["Users"],
					security: [{ bearerAuth: [] }],
					description: "Requires users:read.",
				},
			},
			async ({ request, operation }) => {
				const result = await service.read(collectionQuery(request), operation);
				if (
					!Array.isArray(result.data) ||
					result.pageLimit === undefined ||
					result.nextCursor === undefined
				)
					throw new Error("Expected user collection");
				return {
					data: result.data,
					pageLimit: result.pageLimit,
					nextCursor: result.nextCursor,
				};
			},
		)
		.get(
			"/users/:id",
			{
				params: t.Object({ id: httpModel.id }),
				response: userModel.singleResponse,
				detail: {
					tags: ["Users"],
					security: [{ bearerAuth: [] }],
					"x-required-scope": "users:read",
				},
			},
			async ({ request, params, operation }) => {
				const result = await service.read(
					detailQuery(request, params.id),
					operation,
				);
				if ("nextCursor" in result) throw new Error("Expected user detail");
				return result;
			},
		);
