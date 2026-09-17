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
			{
				detail: {
					tags: ["Runtime sessions"],
					operationId: "activateSession",
					summary: "Activate a license",
					description:
						"Exchange a license key and stable device identifier for a session token. Checks license validity, access rules, and device/IP/session limits. The first successful trial activation starts its timer. Save the token and refresh it before expiresIn seconds elapse.",
				},
				body: activationBody,
				response: activationResponse,
			},
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
				detail: {
					tags: ["Runtime sessions"],
					operationId: "heartbeatSession",
					summary: "Refresh a session",
					description:
						"Revalidate the license and extend the session TTL. Send the bearer token, the original X-Device-Id, and an empty JSON object from the same client IP. Expired sessions or changed license revisions require activation again.",
					security: [{ session: [] }],
				},
				response: heartbeatResponse,
				headers: sessionHeaders,
				body: emptyBody,
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
				detail: {
					tags: ["Runtime sessions"],
					operationId: "deactivateSession",
					summary: "Deactivate a session",
					description:
						"Release this active session slot using its bearer token and original device/IP binding. Device and IP registrations remain. Send an empty JSON object.",
					security: [{ session: [] }],
				},
				response: deactivationResponse,
				headers: sessionHeaders,
				body: emptyBody,
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
			detail: {
				tags: ["Runtime usage"],
				operationId: "consumeUsage",
				summary: "Consume metered units",
				description:
					"Consume positive units from a named meter with a valid bound session. Use a unique eventId per license for each logical event. Retrying the same eventId, meter, and units returns the original receipt without charging again. Reusing an eventId with different input or exceeding the meter limit returns 409.",
				security: [{ session: [] }],
			},
			response: usageResponse,
			body: usageBody,
			headers: sessionHeaders,
		},
	);
}

export function sessionAdminRoutes(service: SessionService, guard: AdminGuard) {
	return new Elysia({ prefix: "/admin/sessions", detail: guard.config.detail })
		.use(guard)
		.get("/", ({ query }) => service.list(query), {
			detail: {
				tags: ["Session administration"],
				operationId: "listSessions",
				summary: "List active sessions",
				description:
					"Browse active Redis sessions for the required licenseId. Session IDs are hashes for administration; they are not bearer tokens. TTL is returned in seconds.",
			},
			query: sessionQuery,
			response: sessionsResponse,
		})
		.delete("/:id", ({ params }) => service.terminateAll(params.id), {
			detail: {
				tags: ["Session administration"],
				operationId: "terminateLicenseSessions",
				summary: "Terminate all license sessions",
				description:
					"Invalidate all active sessions for the license UUID. This does not revoke the license or remove device/IP registrations; clients may activate again.",
			},
			response: terminationResponse,
			params: idParams,
		})
		.delete(
			"/:id/:sessionId",
			({ params }) => service.terminate(params.id, params.sessionId),
			{
				detail: {
					tags: ["Session administration"],
					operationId: "terminateSession",
					summary: "Terminate one session",
					description:
						"Invalidate one session using the license UUID and the session ID returned by the admin list endpoint. Clients may activate again if policy permits.",
				},
				params: sessionParams,
				response: terminationResponse,
			},
		);
}
