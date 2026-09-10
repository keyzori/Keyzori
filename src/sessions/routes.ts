import { Elysia } from "elysia";
import type { AdminGuard } from "../shared/adminGuard.ts";
import { emptyBody, idParams } from "../shared/schemas.ts";
import type { ClientIp } from "../shared/ClientIp.ts";
import type { SessionService } from "./SessionService.ts";
import type { MeterService } from "../meters/MeterService.ts";
import { usageBody } from "../meters/schemas.ts";
import {
	activationResponse,
	heartbeatResponse,
	deactivationResponse,
	sessionResponse,
} from "./responses.ts";
import { usageResponse } from "../meters/responses.ts";
import { pageResponse, terminationResponse } from "../shared/responses.ts";
import {
	activationBody,
	sessionHeaders,
	sessionParams,
	sessionQuery,
} from "./schemas.ts";

const sessionsResponse = pageResponse(sessionResponse);
export function sessionRoutes(service: SessionService, ip: ClientIp) {
	return new Elysia({ prefix: "/sessions" })
		.post(
			"/",
			({ body, request, server }) =>
				service.activate(
					body,
					ip.resolve(request, server?.requestIP(request)?.address),
				),
			{ body: activationBody, response: activationResponse },
		)
		.post(
			"/heartbeat",
			({ headers, request, server }) =>
				service.heartbeat({
					token: headers.authorization.slice(7),
					deviceId: headers["x-device-id"],
					ip: ip.resolve(request, server?.requestIP(request)?.address),
				}),
			{
				response: heartbeatResponse,
				headers: sessionHeaders,
				body: emptyBody,
				detail: { security: [{ session: [] }] },
			},
		)
		.post(
			"/deactivate",
			({ headers, request, server }) =>
				service.deactivate({
					token: headers.authorization.slice(7),
					deviceId: headers["x-device-id"],
					ip: ip.resolve(request, server?.requestIP(request)?.address),
				}),
			{
				response: deactivationResponse,
				headers: sessionHeaders,
				body: emptyBody,
				detail: { security: [{ session: [] }] },
			},
		);
}

export function usageRoutes(
	sessions: SessionService,
	meters: MeterService,
	ip: ClientIp,
) {
	return new Elysia({ prefix: "/usage" }).post(
		"/",
		({ body, headers, request, server }) =>
			sessions.withSession(
				{
					token: headers.authorization.slice(7),
					deviceId: headers["x-device-id"],
					ip: ip.resolve(request, server?.requestIP(request)?.address),
				},
				(tx, license) => meters.consume(tx, license, body),
			),
		{
			response: usageResponse,
			body: usageBody,
			headers: sessionHeaders,
			detail: { security: [{ session: [] }] },
		},
	);
}

export function sessionAdminRoutes(service: SessionService, guard: AdminGuard) {
	return new Elysia({ prefix: "/admin/sessions", detail: guard.config.detail })
		.use(guard)
		.get("/", ({ query }) => service.list(query), {
			query: sessionQuery,
			response: sessionsResponse,
		})
		.delete("/:id", ({ params }) => service.terminateAll(params.id), {
			response: terminationResponse,
			params: idParams,
		})
		.delete(
			"/:id/:sessionId",
			({ params }) => service.terminate(params.id, params.sessionId),
			{ params: sessionParams, response: terminationResponse },
		);
}
