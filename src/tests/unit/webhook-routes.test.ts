import { expect, test } from "bun:test";
import { Elysia, ValidationError } from "elysia";
import { HttpError } from "../../core/http/HttpError";
import { webhookRoutes } from "../../plugins/webhooks";
import { webhookModel } from "../../plugins/webhooks/model";
import type { $Requests, $Webhooks } from "../../types/application";
import { checkedJSON } from "../fixtures/Json";

test("webhook collection/detail routes have stable shapes and reject legacy id selection", async () => {
	const id = Bun.randomUUIDv7();
	const resource = {
		id,
		url: "https://receiver.example/",
		events: ["license.created" as const],
		enabled: false,
		allGroups: true,
		groupIds: [],
		signingKeyId: Bun.randomUUIDv7(),
		version: 1,
		lastError: null,
		createdBy: "root",
		updatedBy: "root",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	const delivery = {
		id,
		webhookId: id,
		eventId: Bun.randomUUIDv7(),
		replayOf: null,
		event: "license.created" as const,
		state: "pending" as const,
		attempts: 0,
		attemptedAt: null,
		nextAttemptAt: new Date().toISOString(),
		expiresAt: new Date().toISOString(),
		status: null,
		error: null,
		createdAt: new Date().toISOString(),
	};
	const unavailable = (): never => {
		throw new Error("Unexpected operation");
	};
	const requests: $Requests = {
		authorize: async () => ({
			principal: { kind: "root", id: "root", name: "Root", scopes: [] },
			clientIp: "127.0.0.1",
			requestId: Bun.randomUUIDv7(),
		}),
		runtime: unavailable,
		admit: unavailable,
	};
	const service: $Webhooks = {
		create: unavailable,
		update: unavailable,
		delete: unavailable,
		enable: unavailable,
		disable: unavailable,
		rotateSecret: unavailable,
		replay: unavailable,
		recover: unavailable,
		read: async (params) =>
			params.has("id")
				? { data: resource }
				: { data: [resource], nextCursor: null, pageLimit: 50 },
		deliveryHistory: async (params) =>
			params.has("id")
				? { data: delivery }
				: { data: [delivery], nextCursor: null, pageLimit: 50 },
	};
	const app = new Elysia({ normalize: false })
		.error("global", ValidationError, () => new Response(null, { status: 400 }))
		.error(
			"global",
			HttpError,
			({ error }) => new Response(null, { status: error.status }),
		)
		.use(webhookRoutes(service, requests));
	const get = (path: string) =>
		app.handle(new Request(`http://localhost${path}`));
	expect(
		(await checkedJSON(await get("/webhooks"), webhookModel.listResponse)).data,
	).toEqual([resource]);
	expect(
		(
			await checkedJSON(
				await get(`/webhooks/${id}`),
				webhookModel.detailResponse,
			)
		).data,
	).toEqual(resource);
	expect(
		(
			await checkedJSON(
				await get("/webhooks/deliveries"),
				webhookModel.historyListResponse,
			)
		).data,
	).toEqual([delivery]);
	expect(
		(
			await checkedJSON(
				await get(`/webhooks/deliveries/${id}`),
				webhookModel.historyDetailResponse,
			)
		).data,
	).toEqual(delivery);
	for (const path of [
		`/webhooks?id=${id}`,
		`/webhooks/deliveries?id=${id}`,
		`/webhooks/${id}?limit=1`,
		"/webhooks?limit=101",
	])
		expect((await get(path)).status).toBe(400);
});
