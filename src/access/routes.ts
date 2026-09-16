import { Elysia } from "elysia";
import type { AdminGuard } from "../shared/adminGuard.ts";
import { idParams, pageQuery } from "../shared/schemas.ts";
import type { AccessService } from "./AccessService.ts";
import {
	accessResponse,
	allowlistsResponse,
	deviceResponse,
	ipResponse,
	registrationResponse,
} from "./responses.ts";
import { licenseResponse } from "../licenses/responses.ts";
import { pageResponse } from "../shared/responses.ts";
import {
	allowlistBody,
	blockBody,
	policyBody,
	registrationParams,
} from "./schemas.ts";

const devicesResponse = pageResponse(deviceResponse);
const ipsResponse = pageResponse(ipResponse);
export function accessRoutes(service: AccessService, guard: AdminGuard) {
	return new Elysia({ prefix: "/admin/access", detail: guard.config.detail })
		.use(guard)
		.get("/:id", ({ params }) => service.get(params.id), {
			detail: {
				tags: ["Access controls"],
				operationId: "getLicenseAccess",
				summary: "Get access settings",
				description:
					"Read the license policy and device/IP allowlists. The id parameter is the license UUID.",
			},
			params: idParams,
			response: accessResponse,
		})
		.patch("/:id", ({ params, body }) => service.policy(params.id, body), {
			detail: {
				tags: ["Access controls"],
				operationId: "updateLicensePolicy",
				summary: "Update access limits",
				description:
					"Patch device, IP, and active-session limits or enable allowlist enforcement. Omitted values stay unchanged. The policy revision advances, invalidating existing sessions.",
			},
			response: licenseResponse,
			params: idParams,
			body: policyBody,
		})
		.put(
			"/:id/allowlists",
			({ params, body }) => service.allowlists(params.id, body),
			{
				detail: {
					tags: ["Access controls"],
					operationId: "replaceAllowlists",
					summary: "Replace allowlists",
					description:
						"Replace both lists together. Supply raw device identifiers and IPv4/IPv6 addresses or CIDR networks; device identifiers are hashed before storage. Empty arrays clear the lists. Enable enforcement separately through the policy endpoint. Existing sessions become invalid.",
				},
				params: idParams,
				body: allowlistBody,
				response: allowlistsResponse,
			},
		)
		.get(
			"/:id/devices",
			({ params, query }) => service.devices(params.id, query),
			{
				detail: {
					tags: ["Access controls"],
					operationId: "listDevices",
					summary: "List registered devices",
					description:
						"Browse devices registered to the license, including blocked registrations. Device identifiers are stored as hashes.",
				},
				params: idParams,
				query: pageQuery,
				response: devicesResponse,
			},
		)
		.get("/:id/ips", ({ params, query }) => service.ips(params.id, query), {
			detail: {
				tags: ["Access controls"],
				operationId: "listIps",
				summary: "List registered IPs",
				description:
					"Browse IP registrations for the license, including their blocked state.",
			},
			response: ipsResponse,
			params: idParams,
			query: pageQuery,
		})
		.patch(
			"/:id/devices/:registrationId",
			({ params, body }) =>
				service.registration(
					params.id,
					params.registrationId,
					"device",
					body.blocked,
				),
			{
				detail: {
					tags: ["Access controls"],
					operationId: "setDeviceBlock",
					summary: "Block or unblock a device",
					description:
						"Set blocked on the specified device registration. The id is the license UUID and registrationId is the registration UUID. Existing sessions become invalid.",
				},
				params: registrationParams,
				body: blockBody,
				response: registrationResponse,
			},
		)
		.delete(
			"/:id/devices/:registrationId",
			({ params }) =>
				service.registration(params.id, params.registrationId, "device", null),
			{
				detail: {
					tags: ["Access controls"],
					operationId: "deleteDeviceRegistration",
					summary: "Remove a device registration",
					description:
						"Remove the registration to free a device slot. This does not prevent the device from registering again when policy permits. Existing sessions become invalid.",
				},
				params: registrationParams,
				response: registrationResponse,
			},
		)
		.patch(
			"/:id/ips/:registrationId",
			({ params, body }) =>
				service.registration(
					params.id,
					params.registrationId,
					"ip",
					body.blocked,
				),
			{
				detail: {
					tags: ["Access controls"],
					operationId: "setIpBlock",
					summary: "Block or unblock an IP",
					description:
						"Set blocked on the specified IP registration. The id is the license UUID and registrationId is the registration UUID. Existing sessions become invalid.",
				},
				params: registrationParams,
				body: blockBody,
				response: registrationResponse,
			},
		)
		.delete(
			"/:id/ips/:registrationId",
			({ params }) =>
				service.registration(params.id, params.registrationId, "ip", null),
			{
				detail: {
					tags: ["Access controls"],
					operationId: "deleteIpRegistration",
					summary: "Remove an IP registration",
					description:
						"Remove the registration to free an IP slot. This does not ban future registration of the address. Existing sessions become invalid.",
				},
				params: registrationParams,
				response: registrationResponse,
			},
		);
}
