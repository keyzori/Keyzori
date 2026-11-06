import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";
import { t } from "elysia";
import { httpModel } from "../../../core/http/model";
import {
	collectionQuery,
	detailQuery,
} from "../../../core/http/resourceRequest";

export const readLicense = (service: $Licenses, requests: $Requests) =>
	guard(requests, "licenses:read")
		.get(
			"/licenses",
			{
				response: licenseModel.read.anyOf[1],
				detail: {
					tags: ["License"],
					summary: "read licenses",
					security: [{ bearerAuth: [] }],
					"x-required-scope": "licenses:read",
				},
			},
			async ({ request, operation }) => {
				const result = await service.read(collectionQuery(request), operation);
				if (
					!Array.isArray(result.data) ||
					result.pageLimit === undefined ||
					result.nextCursor === undefined
				)
					throw new Error("Expected licence collection");
				return {
					data: result.data,
					pageLimit: result.pageLimit,
					nextCursor: result.nextCursor,
				};
			},
		)
		.get(
			"/licenses/:id",
			{
				params: t.Object({ id: httpModel.id }),
				response: licenseModel.read.anyOf[0],
				detail: {
					tags: ["License"],
					security: [{ bearerAuth: [] }],
					"x-required-scope": "licenses:read",
				},
			},
			async ({ request, params, operation }) => {
				const result = await service.read(
					detailQuery(request, params.id),
					operation,
				);
				if ("nextCursor" in result) throw new Error("Expected licence detail");
				return result;
			},
		);
