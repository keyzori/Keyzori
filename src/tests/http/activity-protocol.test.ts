import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { connect } from "node:net";
import { t } from "elysia";
import { Check } from "typebox/value";
import { TestHttp } from "../fixtures/TestHttp";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { activityModel } from "../../plugins/activity/model";
import type { ActivityOptions } from "../../plugins/activity/options";
import { EventService } from "../../plugins/webhooks/EventService";
import { createApp } from "../../app";
import type { $Operation } from "../../types/operation";
import type { $ApiKeyUpdate } from "../../types/apiKeys";
import { Metrics } from "../../core/observability/Metrics";
import { WebhookService } from "../../plugins/webhooks/WebhookService";
import { IdempotencyService } from "../../core/security/IdempotencyService";

const context = new TestHttp();
const events = new EventService();
beforeAll(() => context.start());
afterAll(() => context.stop());
const root = (): $Operation => ({
	principal: { kind: "root", id: "root", name: "Root", scopes: [] },
	requestId: Bun.randomUUIDv7(),
	idempotencyKey: Bun.randomUUIDv7(),
	clientIp: "127.0.0.1",
});
const batchSchema = t.Object(
	{
		type: t.Literal("events"),
		data: t.Array(activityModel.event),
		cursor: t.String(),
		hasMore: t.Boolean(),
	},
	{ additionalProperties: false },
);

async function until(predicate: () => boolean, timeout = 4000) {
	const deadline = Date.now() + timeout;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	expect(predicate()).toBe(true);
}

async function key(
	changes: $ApiKeyUpdate["changes"] = {
		scopes: ["events:read", "events:subscribe", "licenses:read"],
		allGroups: true,
	},
) {
	const issued = await context.services.apiKeys.create(
		{ name: "Activity protocol" },
		root(),
	);
	await context.services.apiKeys.update(
		{ ids: [issued.data.id], changes },
		root(),
	);
	await context.services.apiKeys.enable({ ids: [issued.data.id] }, root());
	return issued;
}

function client(
	credential: string | null,
	options: { url?: URL; headers?: Record<string, string>; query?: string } = {},
) {
	const url = new URL("/events/stream", options.url ?? context.app.server?.url);
	url.protocol = "ws:";
	url.search = options.query ?? "";
	const socket = new WebSocket(url, {
		headers: {
			...(credential ? { Authorization: `Bearer ${credential}` } : {}),
			...options.headers,
		},
	});
	const frames: unknown[] = [];
	let opened = false;
	const handshake = Promise.withResolvers<boolean>();
	socket.addEventListener("open", () => {
		opened = true;
		handshake.resolve(true);
	});
	socket.addEventListener("error", () => handshake.resolve(false));
	socket.addEventListener("close", () => handshake.resolve(false));
	socket.addEventListener("message", (message) => {
		frames.push(JSON.parse(String(message.data)));
	});
	const closed = new Promise<CloseEvent>((resolve) =>
		socket.addEventListener("close", resolve, { once: true }),
	);
	return {
		socket,
		frames,
		closed,
		handshake: handshake.promise,
		opened: () => opened,
		async ready() {
			await until(() =>
				frames.some(
					(frame) =>
						frame &&
						typeof frame === "object" &&
						"type" in frame &&
						frame.type === "ready",
				),
			);
		},
		subscribe(cursor?: string) {
			socket.send(
				JSON.stringify({ type: "subscribe", ...(cursor ? { cursor } : {}) }),
			);
		},
		batches() {
			return frames.flatMap((frame) =>
				Check(batchSchema, frame) ? [frame] : [],
			);
		},
	};
}

async function custom(options: ActivityOptions = {}, origins: string[] = []) {
	const metrics = new Metrics();
	const service = new ActivityService(
		context.services.database,
		context.services.auth,
		context.services.redis,
		origins,
		100,
		{ pollIntervalMs: 20, replayIntervalMs: 1, ...options },
		metrics,
	);
	const app = createApp(
		{ ...context.services, activity: service },
		context.services.tracker,
		context.services.logger,
		context.services.metrics,
	);
	app.listen({ hostname: "127.0.0.1", port: 0 });
	return {
		service,
		metrics,
		app,
		url: app.server?.url,
		async stop() {
			service.stop();
			await app.stop(true);
		},
	};
}

test("real handshakes require backend Bearer credentials, subscription scope and an allowed origin", async () => {
	const missingScope = await key({
		scopes: ["events:read", "licenses:read"],
		allGroups: true,
	});
	const granted = await key();
	const denied = [
		client(null),
		client("wrong"),
		client(missingScope.credential),
		client(granted.credential, {
			headers: { Origin: "https://untrusted.example" },
		}),
		client(null, { query: `ticket=${granted.credential}` }),
		client(granted.credential, { query: "cursor=ignored" }),
		client(null, {
			headers: { Cookie: `Authorization=Bearer ${granted.credential}` },
		}),
	];
	try {
		expect(
			await Promise.all(denied.map((connection) => connection.handshake)),
		).toEqual(denied.map(() => false));
		for (const connection of denied) expect(connection.opened()).toBe(false);
	} finally {
		for (const connection of denied) connection.socket.terminate();
	}
	const server = await custom({}, ["https://trusted.example"]);
	const allowed = client(granted.credential, {
		url: server.url,
		headers: { Origin: "https://trusted.example" },
	});
	try {
		await allowed.ready();
		expect(allowed.opened()).toBe(true);
	} finally {
		allowed.socket.terminate();
		await server.stop();
	}
});

test("real subscribed sockets with no domain-read permission receive no domain payloads", async () => {
	const issued = await key({ scopes: ["events:subscribe"], allGroups: true });
	await context.services.database.transaction((tx) =>
		events.emit(tx, "license.created", {
			licenseId: Bun.randomUUIDv7(),
			groupId: null,
		}),
	);
	await context.services.activity.publish(1000);
	const connection = client(issued.credential);
	try {
		await connection.ready();
		connection.subscribe();
		await until(() => connection.batches().length > 0);
		expect(connection.batches()[0]?.data).toEqual([]);
	} finally {
		connection.socket.terminate();
	}
});

test("webhook lifecycle history and forwarding are master-only even for all-groups API keys", async () => {
	const issued = await key({
		scopes: [
			"events:read",
			"events:subscribe",
			"webhooks:read",
			"webhooks:create",
		],
		allGroups: true,
	});
	const operation = {
		...root(),
		principal: await context.services.auth.authenticate(
			`Bearer ${issued.credential}`,
		),
	};
	await context.services.activity.publish(1000);
	const apiCursor = (await context.services.activity.watermark(operation)).data
		.cursor;
	const rootCursor = (await context.services.activity.watermark(root())).data
		.cursor;
	const webhookId = Bun.randomUUIDv7();
	const lifecycle = [
		"webhook.created",
		"webhook.updated",
		"webhook.enabled",
		"webhook.disabled",
		"webhook.deleted",
	] as const;
	await context.services.database.transaction(async (tx) => {
		for (const event of lifecycle) await events.emit(tx, event, { webhookId });
	});
	await context.services.activity.publish(1000);
	const replay = await context.request(`/events?cursor=${apiCursor}`, {
		credential: issued.credential,
	});
	expect(replay.status).toBe(200);
	expect(await replay.json()).toMatchObject({ ok: true, data: [] });
	const master = await context.request(`/events?cursor=${rootCursor}`);
	expect(master.status).toBe(200);
	expect(await master.json()).toMatchObject({
		data: lifecycle.map((event) =>
			expect.objectContaining({ event, data: { webhookId } }),
		),
	});
	const apiSocket = client(issued.credential);
	const masterSocket = client(context.master);
	try {
		await Promise.all([apiSocket.ready(), masterSocket.ready()]);
		apiSocket.subscribe(apiCursor);
		masterSocket.subscribe(rootCursor);
		await until(
			() => apiSocket.batches().length > 0 && masterSocket.batches().length > 0,
		);
		expect(apiSocket.batches()[0]?.data).toEqual([]);
		expect(JSON.stringify(apiSocket.frames)).not.toContain(webhookId);
		expect(masterSocket.batches()[0]?.data.map((event) => event.event)).toEqual(
			[...lifecycle],
		);
		const forwarder = new WebhookService(
			context.services.database,
			context.services.auth,
			context.services.audit,
			context.services.settings,
			new IdempotencyService(
				context.services.database,
				context.services.settings,
				context.services.auth,
			),
			{ encryptionKey: "a".repeat(64) },
		);
		for (const event of lifecycle) {
			const input = {
				url: "https://receiver.example/events",
				events: [event],
				allGroups: true,
			};
			await expect(
				forwarder.create(input, {
					...operation,
					idempotencyKey: Bun.randomUUIDv7(),
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const created = await forwarder.create(input, root());
			expect(created.data.events).toEqual([event]);
		}
	} finally {
		apiSocket.socket.terminate();
		masterSocket.socket.terminate();
	}
});

test("invalid JSON, unknown actions, extra fields and oversized messages close real sockets", async () => {
	const issued = await key();
	for (const body of [
		"{",
		JSON.stringify({ type: "ping" }),
		JSON.stringify({ type: "subscribe", ticket: "ignored" }),
		JSON.stringify({ type: "subscribe", cursor: "x".repeat(513) }),
	]) {
		const connection = client(issued.credential);
		try {
			await connection.ready();
			connection.socket.send(body);
			expect((await connection.closed).code).toBe(1008);
		} finally {
			connection.socket.terminate();
		}
	}
	const oversized = client(issued.credential);
	try {
		await oversized.ready();
		oversized.socket.send("x".repeat(2048));
		expect((await oversized.closed).code).toBe(1009);
	} finally {
		oversized.socket.terminate();
	}
});

test("current revoke and grant edits invalidate a live cursor; reconnect uses the new group authority", async () => {
	const a = await context.services.groups.create({ name: "Stream A" }, root());
	const b = await context.services.groups.create({ name: "Stream B" }, root());
	const scopes: NonNullable<$ApiKeyUpdate["changes"]["scopes"]> = [
		"events:read",
		"events:subscribe",
		"licenses:read",
	];
	const issued = await key({ scopes, groupIds: [a.data.id] });
	const server = await custom();
	const connection = client(issued.credential, { url: server.url });
	let next: ReturnType<typeof client> | undefined;
	try {
		await connection.ready();
		connection.subscribe();
		await until(() => connection.batches().length > 0);
		const oldCursor = connection.batches().at(-1)?.cursor;
		if (!oldCursor) throw new Error("Expected cursor");
		await context.services.apiKeys.update(
			{ ids: [issued.data.id], changes: { groupIds: [b.data.id] } },
			root(),
		);
		const hidden = Bun.randomUUIDv7();
		const visible = Bun.randomUUIDv7();
		await context.services.database.transaction(async (tx) => {
			await events.emit(tx, "license.created", {
				licenseId: hidden,
				groupId: a.data.id,
			});
			await events.emit(tx, "license.created", {
				licenseId: visible,
				groupId: b.data.id,
			});
		});
		await server.service.publish(1000);
		expect((await connection.closed).code).toBe(1008);
		expect(connection.frames).toContainEqual({
			type: "error",
			code: "CURSOR_EXPIRED",
			resync: "/events/watermark",
		});
		expect(JSON.stringify(connection.frames)).not.toContain(hidden);
		const operation = {
			...root(),
			principal: await context.services.auth.authenticate(
				`Bearer ${issued.credential}`,
			),
		};
		await expect(
			server.service.read(
				new URLSearchParams({ cursor: oldCursor }),
				operation,
			),
		).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
		next = client(issued.credential, { url: server.url });
		await next.ready();
		next.subscribe();
		const active = next;
		await until(() => JSON.stringify(active.batches()).includes(visible));
		expect(JSON.stringify(next.batches())).not.toContain(hidden);
		await context.services.apiKeys.disable({ ids: [issued.data.id] }, root());
		expect((await next.closed).code).toBe(1008);
		expect(next.frames).toContainEqual({ type: "error", code: "UNAUTHORIZED" });
	} finally {
		connection.socket.terminate();
		next?.socket.terminate();
		await server.stop();
	}
});

test("distributed admission counts streams across replicas and frees a closed lease", async () => {
	const issued = await key();
	const first = await custom();
	const second = await custom();
	const connections: ReturnType<typeof client>[] = [];
	try {
		for (let i = 0; i < 5; i++) {
			const connection = client(issued.credential, {
				url: i % 2 ? first.url : second.url,
			});
			connections.push(connection);
			await connection.ready();
		}
		const rejected = client(issued.credential, { url: second.url });
		connections.push(rejected);
		expect((await rejected.closed).code).toBe(1013);
		connections[0]?.socket.close();
		await connections[0]?.closed;
		const deadline = Date.now() + 2000;
		while (
			(await context.services.redis.send("ZCARD", [
				`kz:streams:principal:${issued.data.id}`,
			])) !== 4
		) {
			if (Date.now() >= deadline) throw new Error("Lease was not released");
			await Bun.sleep(5);
		}
		const replacement = client(issued.credential, { url: second.url });
		connections.push(replacement);
		await replacement.ready();
	} finally {
		for (const connection of connections) connection.socket.terminate();
		await first.stop();
		await second.stop();
	}
});

test("lost Redis leases, subscription deadlines and session deadlines stop real delivery", async () => {
	const issued = await key();
	const lease = await custom({
		leaseMs: 1000,
		leaseSafetyMs: 100,
		renewEveryMs: 100,
	});
	const connection = client(issued.credential, { url: lease.url });
	try {
		await connection.ready();
		connection.subscribe();
		await until(() => connection.batches().length > 0);
		await context.services.redis.send("DEL", [
			`kz:streams:principal:${issued.data.id}`,
		]);
		expect((await connection.closed).code).toBe(1008);
		expect(connection.frames).toContainEqual({
			type: "error",
			code: "SERVICE_UNAVAILABLE",
		});
	} finally {
		connection.socket.terminate();
		await lease.stop();
	}
	const deadline = await custom({ subscribeTimeoutMs: 150 });
	const idle = client(issued.credential, { url: deadline.url });
	try {
		await idle.ready();
		expect((await idle.closed).code).toBe(1008);
	} finally {
		idle.socket.terminate();
		await deadline.stop();
	}
	const lifetime = await custom({ sessionLifetimeMs: 300 });
	const expired = client(issued.credential, { url: lifetime.url });
	try {
		await expired.ready();
		expired.subscribe();
		await until(() => expired.batches().length > 0);
		expect((await expired.closed).code).toBe(1008);
	} finally {
		expired.socket.terminate();
		await lifetime.stop();
	}
});

test("the distributed per-IP cap applies across different credentials", async () => {
	const server = await custom();
	const connections: ReturnType<typeof client>[] = [];
	try {
		for (let owner = 0; owner < 5; owner++) {
			const issued = await key();
			for (let stream = 0; stream < 4; stream++) {
				const connection = client(issued.credential, { url: server.url });
				connections.push(connection);
				await connection.ready();
			}
		}
		const another = await key();
		const rejected = client(another.credential, { url: server.url });
		connections.push(rejected);
		expect((await rejected.closed).code).toBe(1013);
	} finally {
		for (const connection of connections) connection.socket.terminate();
		await server.stop();
	}
});

test("a saved cursor is not portable to another credential with identical grants", async () => {
	const first = await key();
	const second = await key();
	const operation = {
		...root(),
		principal: await context.services.auth.authenticate(
			`Bearer ${first.credential}`,
		),
	};
	const watermark = (await context.services.activity.watermark(operation)).data;
	const connection = client(second.credential);
	try {
		await connection.ready();
		connection.subscribe(watermark.cursor);
		expect((await connection.closed).code).toBe(1008);
		expect(connection.frames).toContainEqual({
			type: "error",
			code: "CURSOR_EXPIRED",
			resync: "/events/watermark",
		});
		expect(connection.batches()).toEqual([]);
	} finally {
		connection.socket.terminate();
	}
});

test("processed cursors reconnect across replay/live publication and shutdown", async () => {
	const issued = await key();
	const server = await custom();
	const operation = {
		...root(),
		principal: await context.services.auth.authenticate(
			`Bearer ${issued.credential}`,
		),
	};
	const start = (await server.service.watermark(operation)).data;
	const replay = await context.services.database.transaction((tx) =>
		events.emit(tx, "license.created", {
			licenseId: Bun.randomUUIDv7(),
			groupId: null,
		}),
	);
	await server.service.publish(1000);
	const connection = client(issued.credential, { url: server.url });
	let resumed: ReturnType<typeof client> | undefined;
	try {
		await connection.ready();
		connection.subscribe(start.cursor);
		await until(() =>
			connection
				.batches()
				.some((batch) => batch.data.some((event) => event.id === replay.id)),
		);
		const processed = connection.batches().at(-1)?.cursor;
		if (!processed) throw new Error("Expected processed cursor");
		connection.socket.close();
		await connection.closed;
		const next = await context.services.database.transaction((tx) =>
			events.emit(tx, "license.updated", {
				licenseId: replay.resource.id,
				groupId: null,
			}),
		);
		await server.service.publish(1000);
		resumed = client(issued.credential, { url: server.url });
		await resumed.ready();
		resumed.subscribe(processed);
		const active = resumed;
		await until(() =>
			active
				.batches()
				.some((batch) => batch.data.some((event) => event.id === next.id)),
		);
		expect(
			active.batches().flatMap((batch) => batch.data.map((event) => event.id)),
		).toEqual([next.id]);
		server.service.stop();
		expect((await active.closed).code).toBe(1012);
		const stopped = client(issued.credential, { url: server.url });
		try {
			expect((await stopped.closed).code).toBe(1013);
		} finally {
			stopped.socket.terminate();
		}
	} finally {
		connection.socket.terminate();
		resumed?.socket.terminate();
		await server.stop();
	}
});

test("a paused real TCP WebSocket is closed on native backpressure with bounded batches", async () => {
	const issued = await key();
	const server = await custom();
	const payload = await context.services.database.transaction((tx) =>
		events.emit(tx, "license.created", {
			licenseId: Bun.randomUUIDv7(),
			groupId: null,
		}),
	);
	const watermark = (await server.service.watermark(root())).data;
	const batch = {
		data: Array.from({ length: 100 }, (_, i) => ({
			...payload,
			sequence: String(i + 1),
			epoch: watermark.epoch,
		})),
		cursor: watermark.cursor,
		pageLimit: 100,
		hasMore: true,
	};
	// A finite database history is irrelevant to transport saturation. Feed valid
	// bounded batches quickly, while exercising Bun's actual send return values.
	const read = spyOn(server.service, "read").mockResolvedValue(batch);
	const close = spyOn(server.service, "close");
	const gauges = spyOn(server.metrics, "setGauge");
	const url = server.url;
	if (!url) throw new Error("Expected listening server");
	const raw = connect({ host: "127.0.0.1", port: Number(url.port) });
	let headers = "";
	raw.on("error", () => {});
	raw.on("data", (chunk) => {
		headers += chunk.toString("latin1");
		if (headers.includes("\r\n\r\n")) {
			raw.pause();
		}
	});
	try {
		await new Promise<void>((resolve) => raw.once("connect", resolve));
		raw.write(
			`GET /events/stream HTTP/1.1\r\nHost: 127.0.0.1:${url.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.alloc(16, 7).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${issued.credential}\r\n\r\n`,
		);
		await until(() => headers.includes("\r\n\r\n"));
		expect(headers).toStartWith("HTTP/1.1 101");
		const body = Buffer.from(JSON.stringify({ type: "subscribe" }));
		const mask = Buffer.from([1, 2, 3, 4]);
		raw.write(
			Buffer.concat([
				Buffer.from([0x81, 0x80 | body.length]),
				mask,
				Buffer.from(body.map((byte, i) => byte ^ (mask[i % 4] ?? 0))),
			]),
		);
		await until(
			() =>
				close.mock.calls.some(
					(call) => call[1] === 1013 && call[2]?.startsWith("Slow consumer"),
				),
			8000,
		);
		expect(read.mock.calls.length).toBeGreaterThan(1);
		expect(
			gauges.mock.calls.some(
				([name, value]) => name === "keyzori_stream_queue_bytes" && value > 0,
			),
		).toBe(true);
		expect(server.metrics.text()).toContain("keyzori_streams_active 0\n");
		expect(server.metrics.text()).toContain(
			"keyzori_stream_queue_messages 0\n",
		);
		expect(server.metrics.text()).toContain("keyzori_stream_queue_bytes 0\n");
	} finally {
		raw.destroy();
		read.mockRestore();
		close.mockRestore();
		gauges.mockRestore();
		await server.stop();
	}
}, 15000);
