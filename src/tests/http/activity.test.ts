import { afterAll, beforeAll, expect, test } from "bun:test";
import { TestHttp } from "../fixtures/TestHttp";
import { t } from "elysia";
import { checkedJSON } from "../fixtures/Json";

const context = new TestHttp();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("real WebSocket handshake, replay, duplicate subscribe and revoked credentials enforce the protocol", async () => {
	const response = await context.request("/api-keys", {
		method: "POST",
		body: { name: "stream" },
		headers: { "Idempotency-Key": Bun.randomUUIDv7() },
	});
	expect(response.status).toBe(200);
	const key = (
		await checkedJSON(
			response,
			t.Object({
				data: t.Object({
					id: t.String({ format: "uuid" }),
					credential: t.String(),
				}),
			}),
		)
	).data;
	await context.request("/api-keys", {
		method: "PATCH",
		body: {
			ids: [key.id],
			changes: {
				scopes: ["events:read", "events:subscribe", "licenses:read"],
				allGroups: true,
			},
		},
	});
	await context.request("/api-keys/enable", {
		method: "POST",
		body: { ids: [key.id] },
	});
	const issued = await context.request("/licenses", {
		method: "POST",
		body: {},
		headers: { "Idempotency-Key": Bun.randomUUIDv7() },
	});
	expect(issued.status).toBe(200);
	await context.services.activity.publish();
	const replay = await context.request("/events", {
		credential: key.credential,
	});
	expect(replay.status).toBe(200);
	expect(await replay.json()).toMatchObject({
		ok: true,
		data: expect.arrayContaining([
			expect.objectContaining({ event: "license.created" }),
		]),
		meta: { page: { hasMore: false, nextCursor: expect.any(String) } },
	});
	const url = new URL("/events/stream", context.app.server?.url);
	url.protocol = "ws:";
	const socket = new WebSocket(url, {
		headers: { Authorization: `Bearer ${key.credential}` },
	});
	const frames: unknown[] = [];
	socket.addEventListener("message", (event) =>
		frames.push(JSON.parse(String(event.data))),
	);
	const closed = new Promise<CloseEvent>((resolve) =>
		socket.addEventListener("close", resolve, { once: true }),
	);
	try {
		await until(() => frames.length > 0);
		expect(frames[0]).toMatchObject({ type: "ready", schemaVersion: 1 });
		socket.send(JSON.stringify({ type: "subscribe" }));
		await until(() => frames.length > 1);
		expect(frames[1]).toMatchObject({
			type: "events",
			data: expect.arrayContaining([
				expect.objectContaining({ event: "license.created" }),
			]),
			cursor: expect.any(String),
		});
		socket.send(JSON.stringify({ type: "subscribe" }));
		expect((await closed).code).toBe(1008);
	} finally {
		socket.terminate();
	}
	await context.request("/api-keys/disable", {
		method: "POST",
		body: { ids: [key.id] },
	});
	const rejected = new WebSocket(url, {
		headers: { Authorization: `Bearer ${key.credential}` },
	});
	let opened = false;
	rejected.addEventListener("open", () => {
		opened = true;
	});
	await new Promise<void>((resolve) => {
		rejected.addEventListener("close", () => resolve(), { once: true });
		rejected.addEventListener("error", () => resolve(), { once: true });
	});
	rejected.terminate();
	expect(opened).toBe(false);
	await until(() => context.services.tracker.active === 0);
});

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
	expect(predicate()).toBe(true);
}
