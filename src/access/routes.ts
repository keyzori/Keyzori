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
			params: idParams,
			response: accessResponse,
		})
		.patch("/:id", ({ params, body }) => service.policy(params.id, body), {
			response: licenseResponse,
			params: idParams,
			body: policyBody,
		})
		.put(
			"/:id/allowlists",
			({ params, body }) => service.allowlists(params.id, body),
			{ params: idParams, body: allowlistBody, response: allowlistsResponse },
		)
		.get(
			"/:id/devices",
			({ params, query }) => service.devices(params.id, query),
			{ params: idParams, query: pageQuery, response: devicesResponse },
		)
		.get("/:id/ips", ({ params, query }) => service.ips(params.id, query), {
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
				params: registrationParams,
				body: blockBody,
				response: registrationResponse,
			},
		)
		.delete(
			"/:id/devices/:registrationId",
			({ params }) =>
				service.registration(params.id, params.registrationId, "device", null),
			{ params: registrationParams, response: registrationResponse },
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
				params: registrationParams,
				body: blockBody,
				response: registrationResponse,
			},
		)
		.delete(
			"/:id/ips/:registrationId",
			({ params }) =>
				service.registration(params.id, params.registrationId, "ip", null),
			{ params: registrationParams, response: registrationResponse },
		);
}
