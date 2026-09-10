import { Elysia } from "elysia";
import type { AdminGuard } from "../shared/adminGuard.ts";
import { idParams, emptyBody, reasonBody } from "../shared/schemas.ts";
import type { LicenseService } from "./LicenseService.ts";
import type { AccessService } from "../access/AccessService.ts";
import {
	licenseBody,
	licenseConfig,
	licenseQuery,
	licenseUpdate,
	renewalBody,
} from "./schemas.ts";
import { licenseResponse, createdLicenseResponse } from "./responses.ts";
import { pageResponse } from "../shared/responses.ts";

const licensesResponse = pageResponse(licenseResponse);
export function licenseRoutes(
	service: LicenseService,
	access: AccessService,
	guard: AdminGuard,
) {
	return new Elysia({ prefix: "/admin/licenses", detail: guard.config.detail })
		.use(guard)
		.get("/", ({ query }) => service.list(query), {
			query: licenseQuery,
			response: licensesResponse,
		})
		.post(
			"/",
			({ body, set }) => {
				set.status = 201;
				return service.create(body);
			},
			{ body: licenseBody, response: { 201: createdLicenseResponse } },
		)
		.get("/:id", ({ params }) => service.get(params.id), {
			params: idParams,
			response: licenseResponse,
		})
		.patch("/:id", ({ params, body }) => service.update(params.id, body), {
			params: idParams,
			body: licenseUpdate,
			response: licenseResponse,
		})
		.put(
			"/:id/type",
			({ params, body }) => service.changeType(params.id, body),
			{ params: idParams, body: licenseConfig, response: licenseResponse },
		)
		.post(
			"/:id/renew",
			({ params, body }) => service.renew(params.id, body.expiresAt),
			{ params: idParams, body: renewalBody, response: licenseResponse },
		)
		.post("/:id/rotate", ({ params }) => service.rotate(params.id), {
			params: idParams,
			body: emptyBody,
			response: createdLicenseResponse,
		})
		.post(
			"/:id/revoke",
			({ params, body }) =>
				access.block(params.id, body.reason ?? "Manually revoked."),
			{ params: idParams, body: reasonBody, response: licenseResponse },
		)
		.post("/:id/restore", ({ params }) => access.block(params.id, null), {
			params: idParams,
			body: emptyBody,
			response: licenseResponse,
		});
}
