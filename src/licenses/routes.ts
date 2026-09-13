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
			detail: {
				tags: ["Licenses"],
				operationId: "listLicenses",
				summary: "List licenses",
				description:
					"Browse licenses, optionally filtered by customer and license type. Full license keys are never included.",
			},
			query: licenseQuery,
			response: licensesResponse,
		})
		.post(
			"/",
			({ body, set }) => {
				set.status = 201;
				return service.create(body);
			},
			{
				detail: {
					tags: ["Licenses"],
					operationId: "createLicense",
					summary: "Issue a license",
					description:
						"Create a lifetime, subscription, trial, or metered license for an existing customer. Save the returned key now: it cannot be retrieved again. New licenses allow one device, one IP, and one active session by default.",
				},
				body: licenseBody,
				response: { 201: createdLicenseResponse },
			},
		)
		.get("/:id", ({ params }) => service.get(params.id), {
			detail: {
				tags: ["Licenses"],
				operationId: "getLicense",
				summary: "Get a license",
				description:
					"Read license configuration, access limits, and policy revision by UUID. The secret key and its hash are excluded.",
			},
			params: idParams,
			response: licenseResponse,
		})
		.patch("/:id", ({ params, body }) => service.update(params.id, body), {
			detail: {
				tags: ["Licenses"],
				operationId: "updateLicense",
				summary: "Update a license",
				description:
					"Change the owning customer or replace metadata. Omitted fields remain unchanged. Updating the license advances its revision and invalidates existing sessions.",
			},
			params: idParams,
			body: licenseUpdate,
			response: licenseResponse,
		})
		.put(
			"/:id/type",
			({ params, body }) => service.changeType(params.id, body),
			{
				detail: {
					tags: ["Licenses"],
					operationId: "changeLicenseType",
					summary: "Replace license type",
					description:
						"Replace the complete type configuration. Trials start on their next first activation. Entering metered mode from another type resets meter counters while preserving usage history. Existing sessions become invalid.",
				},
				params: idParams,
				body: licenseConfig,
				response: licenseResponse,
			},
		)
		.post(
			"/:id/renew",
			({ params, body }) => service.renew(params.id, body.expiresAt),
			{
				detail: {
					tags: ["Licenses"],
					operationId: "renewLicense",
					summary: "Extend a subscription",
					description:
						"Set a future expiry later than the current expiry. Only subscription licenses can be renewed. Existing sessions become invalid after the revision changes.",
				},
				params: idParams,
				body: renewalBody,
				response: licenseResponse,
			},
		)
		.post("/:id/rotate", ({ params }) => service.rotate(params.id), {
			detail: {
				tags: ["Licenses"],
				operationId: "rotateLicenseKey",
				summary: "Rotate a license key",
				description:
					"Replace the secret key and invalidate existing sessions. Save the new key from this response; the previous key stops working. Send an empty JSON object.",
			},
			params: idParams,
			body: emptyBody,
			response: createdLicenseResponse,
		})
		.post(
			"/:id/revoke",
			({ params, body }) =>
				access.block(params.id, body.reason ?? "Manually revoked."),
			{
				detail: {
					tags: ["Licenses"],
					operationId: "revokeLicense",
					summary: "Revoke a license",
					description:
						"Add a manual access block with an optional reason. This prevents activation and invalidates existing sessions without removing the license or its history.",
				},
				params: idParams,
				body: reasonBody,
				response: licenseResponse,
			},
		)
		.post("/:id/restore", ({ params }) => access.block(params.id, null), {
			detail: {
				tags: ["Licenses"],
				operationId: "restoreLicense",
				summary: "Restore manual access",
				description:
					"Remove only the manual access block. Other block sources, expiry, and access rules still apply. Existing sessions become invalid. Send an empty JSON object.",
			},
			params: idParams,
			body: emptyBody,
			response: licenseResponse,
		});
}
