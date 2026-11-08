import { Elysia, t } from "elysia";
import { websocket } from "elysia/websocket";
import type { ActivityService } from "./ActivityService";
import type { $Requests } from "../../types/application";
import { guard } from "../../core/http/guard";
import { activityModel } from "./model";

export const activityRoutes = (
	service: Pick<ActivityService, keyof ActivityService>,
	requests: $Requests,
) =>
	new Elysia({ normalize: false })
		.use(
			guard(requests, "events:read").get(
				"/events/watermark",
				{
					query: t.Object({}, { additionalProperties: false }),
					response: t.Object(
						{ data: activityModel.watermark },
						{ additionalProperties: false },
					),
					detail: {
						tags: ["Activity"],
						"x-required-scope": "events:read",
						security: [{ bearerAuth: [] }],
						description:
							"Capture before listing resources, then replay this cursor. List pages are non-atomic. Event payloads are historical invalidations, never current snapshots: serialize authorized refetches per resource, retain its highest processed event revision, and save only processed cursors. CURSOR_EXPIRED restarts this process with a fresh watermark.",
					},
				},
				({ operation }) => service.watermark(operation),
			),
		)
		.use(
			guard(requests, "events:read").get(
				"/events",
				{
					query: t.Object(
						{
							cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
							limit: t.Optional(
								t.String({ pattern: "^(?:[1-9]|[1-9][0-9]|100)$" }),
							),
						},
						{ additionalProperties: false },
					),
					response: t.Object({
						data: t.Array(activityModel.event),
						cursor: t.String(),
						hasMore: t.Boolean(),
						pageLimit: t.Integer({ minimum: 1, maximum: 100 }),
					}),
					detail: {
						tags: ["Activity"],
						"x-required-scope": "events:read",
						security: [{ bearerAuth: [] }],
					},
				},
				({ request, operation }) =>
					service.read(new URL(request.url).searchParams, operation),
			),
		)
		.use(
			guard(requests, "audits:read").get(
				"/audits",
				{
					response: t.Object({
						data: t.Array(activityModel.audit),
						nextCursor: t.Union([t.String(), t.Null()]),
						pageLimit: t.Integer({ minimum: 1, maximum: 100 }),
					}),
					detail: {
						tags: ["Audit"],
						"x-required-scope": "audits:read",
						security: [{ bearerAuth: [] }],
					},
				},
				({ request, operation }) =>
					service.history(new URL(request.url).searchParams, operation),
			),
		)
		.use(
			guard(requests, "events:subscribe")
				.use(
					websocket({
						maxPayloadLength: 1024,
						backpressureLimit: 262144,
						closeOnBackpressureLimit: true,
						idleTimeout: 30,
						perMessageDeflate: false,
						sendPings: true,
					}),
				)
				.ws("/events/stream", {
					detail: {
						tags: ["Activity"],
						"x-required-scope": "events:subscribe",
						security: [{ bearerAuth: [] }],
					},
					// Validation lives in service.message so invalid frames CLOSE rather
					// than leaving an authenticated, unbounded error-producing socket.
					body: t.Unknown(),
					beforeHandle: ({ request }) => service.assertOrigin(request),
					open: (ws) => service.open(ws, ws.operation),
					message: (ws, body) => service.message(ws.id, body),
					close: (ws) => service.close(ws.id),
				}),
		);
