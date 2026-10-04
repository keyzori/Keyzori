import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Elysia, ValidationError } from "elysia";
import { AuthService } from "../../core/auth/AuthService";
import { apiKeys } from "../../core/database/schema/apiKeys";
import { audits } from "../../core/database/schema/audits";
import { deliveries } from "../../core/database/schema/deliveries";
import { webhooks } from "../../core/database/schema/webhooks";
import { ClientIpResolver } from "../../core/http/ClientIpResolver";
import { HttpError } from "../../core/http/HttpError";
import { RateLimiter } from "../../core/http/RateLimiter";
import { RequestService } from "../../core/http/RequestService";
import { Redis } from "../../core/redis/Redis";
import { IdempotencyService } from "../../core/security/IdempotencyService";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { Replay } from "../../core/security/Replay";
import { SecretHasher } from "../../core/security/SecretHasher";
import { AuditService } from "../../plugins/audits/AuditService";
import { SettingsService } from "../../plugins/settings/SettingsService";
import { EventService } from "../../plugins/webhooks/EventService";
import { WebhookDispatcher } from "../../plugins/webhooks/WebhookDispatcher";
import { WebhookService } from "../../plugins/webhooks/WebhookService";
import { webhookRoutes } from "../../plugins/webhooks/index";
import type { $Operation } from "../../types/operation";
import { TestDatabase } from "../fixtures/TestDatabase";

const fixture = new TestDatabase();
const database = fixture.database;
const keys = new KeyGenerator();
const hasher = new SecretHasher();
const master = keys.master();
const auth = new AuthService(database, master);
const audit = new AuditService();
const ip = new ClientIpResolver(database);
const settings = new SettingsService(database, audit, ip);
const idem = new IdempotencyService(database, settings);
const service = new WebhookService(database, auth, audit, settings, idem);
const events = new EventService();
const root: $Operation = {
	principal: { kind: "root", id: "root", name: "Root", scopes: [] },
	requestId: Bun.randomUUIDv7(),
	clientIp: "127.0.0.1",
};
const redisUrl = Bun.env.KZ_TEST_REDIS_URL;
if (!redisUrl)
	throw new Error(
		"KZ_TEST_REDIS_URL is required for webhook HTTP integration tests",
	);
const redis = new Redis(redisUrl);
const requests = new RequestService(auth, ip, new RateLimiter(redis), settings);
const app = new Elysia({ normalize: false })
	.error("global", HttpError, ({ error }) =>
		Response.json(error.response(), { status: error.status }),
	)
	.error("global", ValidationError, () =>
		Response.json(
			{ code: "INVALID_REQUEST", reason: "Request validation failed" },
			{ status: 400 },
		),
	)
	.error("global", Replay, ({ error }) => Response.json(error.result))
	.use(webhookRoutes(service, requests));
const received: {
	path: string;
	method: string;
	contentType: string | null;
	payload: unknown;
	claimed: boolean;
}[] = [];
let releaseHold = Promise.withResolvers<void>();
let holdEntered = Promise.withResolvers<void>();
let streamCancelled = Promise.withResolvers<void>();
const receiver = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		const payload: unknown = await request.json();
		const id =
			payload &&
			typeof payload === "object" &&
			"id" in payload &&
			typeof payload.id === "string"
				? payload.id
				: "";
		const [row] = await database.orm
			.select()
			.from(deliveries)
			.where(sql`${deliveries.payload}->>'id' = ${id}`);
		received.push({
			path,
			method: request.method,
			contentType: request.headers.get("content-type"),
			payload,
			claimed: row?.state === "claimed",
		});
		if (path === "/redirect")
			return new Response("Remote secret", {
				status: 302,
				headers: {
					location: new URL("/redirect-target", request.url).href,
					"x-private": "never-save",
				},
			});
		if (path === "/denied")
			return new Response("Remote secret", { status: 403 });
		if (path === "/failure")
			return new Response("Remote secret", { status: 500 });
		if (path === "/timeout") await Bun.sleep(2000);
		if (path === "/hold") {
			holdEntered.resolve();
			await releaseHold.promise;
		}
		if (path === "/stream")
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode("Unbounded remote content"),
						);
					},
					cancel() {
						streamCancelled.resolve();
					},
				}),
			);
		return new Response(null, { status: 204 });
	},
});

beforeAll(async () => {
	await fixture.start();
	await redis.connect();
	await settings.update(
		{ rateLimitEnabled: false, webhookTimeoutSeconds: 1 },
		root.principal,
		root,
	);
	app.listen({ hostname: "127.0.0.1", port: 0 });
});
beforeEach(async () => {
	await database.orm.delete(deliveries);
	await database.orm.delete(webhooks);
	received.length = 0;
	releaseHold = Promise.withResolvers<void>();
	holdEntered = Promise.withResolvers<void>();
	streamCancelled = Promise.withResolvers<void>();
});
afterAll(async () => {
	releaseHold.resolve();
	await app.stop();
	await receiver.stop(true);
	redis.close();
	await fixture.stop();
});

describe("webhook configuration", () => {
	test("creates disabled endpoints for public, private, loopback and internal HTTP(S) URLs", async () => {
		for (const url of [
			"https://example.com/hook",
			"http://10.0.0.1/hook",
			"http://127.0.0.1/hook",
			"http://[::1]/hook",
			"http://receiver/hook",
		]) {
			const result = await service.create({ url, events: ["*"] }, root);
			expect(result.data.enabled).toBe(false);
			expect(Object.keys(result.data).sort()).toEqual([
				"createdAt",
				"createdBy",
				"enabled",
				"events",
				"id",
				"updatedAt",
				"updatedBy",
				"url",
			]);
		}
		expect(await database.orm.select().from(deliveries)).toHaveLength(0);
	});

	test("rejects malformed URLs and overlapping subscriptions", async () => {
		for (const url of [
			"ftp://receiver/hook",
			"//receiver/hook",
			"http://",
			"http://user:secret@receiver/hook",
			"http://receiver/has space",
			"http:\\receiver",
			"http://receiver/#fragment",
		]) {
			await expect(
				service.create({ url, events: ["*"] }, root),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		}
		for (const subscriptions of [
			[],
			["*", "license.created"],
			["license.created", "license.created"],
		] satisfies ("*" | "license.created")[][]) {
			await expect(
				service.create({ url: receiver.url.href, events: subscriptions }, root),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		}
	});

	test("normalises event order and suppresses no-op evidence and timestamps", async () => {
		const created = await service.create(
			{ url: receiver.url.href, events: ["user.deleted", "user.created"] },
			root,
		);
		const result = await service.update(
			{
				ids: [created.data.id],
				changes: { events: ["user.created", "user.deleted"] },
			},
			root,
		);
		await service.disable({ ids: [created.data.id] }, root);
		expect(result.data[0]?.updatedAt).toBe(created.data.updatedAt);
		expect(
			await database.orm
				.select()
				.from(audits)
				.where(eq(audits.targetId, created.data.id)),
		).toHaveLength(1);
		await service.enable({ ids: [created.data.id] }, root);
		await service.update(
			{
				ids: [created.data.id],
				changes: { url: new URL("/new", receiver.url).href },
				reason: "Move receiver",
			},
			root,
		);
		expect(
			await database.orm
				.select()
				.from(audits)
				.where(eq(audits.targetId, created.data.id)),
		).toHaveLength(3);
		expect(await database.orm.select().from(deliveries)).toHaveLength(0);
	});

	test("enforces action scopes and atomic bulk selection", async () => {
		const hook = await service.create(
			{ url: receiver.url.href, events: ["*"] },
			root,
		);
		const scoped: $Operation = {
			...root,
			principal: {
				kind: "api",
				id: Bun.randomUUIDv7(),
				name: "Read only",
				scopes: ["webhooks:read"],
			},
		};
		await expect(
			service.update(
				{ ids: [hook.data.id], changes: { url: "http://receiver/changed" } },
				scoped,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			service.enable({ ids: [hook.data.id, Bun.randomUUIDv7()] }, root),
		).rejects.toMatchObject({ code: "BULK_OPERATION_FAILED" });
		expect(
			(
				await database.orm
					.select()
					.from(webhooks)
					.where(eq(webhooks.id, hook.data.id))
			)[0]?.enabled,
		).toBe(false);
		await expect(
			service.delete({ ids: [hook.data.id], confirm: true, reason: "" }, root),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});

	test("idempotent concurrent creates persist one endpoint and replay its safe response", async () => {
		const operation = { ...root, idempotencyKey: Bun.randomUUIDv7() };
		const input = { url: receiver.url.href, events: ["*" as const] };
		const results = await Promise.allSettled(
			Array.from({ length: 4 }, () => service.create(input, operation)),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		for (const result of results)
			if (result.status === "rejected")
				expect(result.reason).toBeInstanceOf(Replay);
		expect(await database.orm.select().from(webhooks)).toHaveLength(1);
	});

	test("disabled endpoints do not receive events; subscription changes do not rewrite queued payloads", async () => {
		const hook = await service.create(
			{ url: new URL("/success", receiver.url).href, events: ["user.created"] },
			root,
		);
		await database.transaction((tx) =>
			events.emit(tx, "user.created", { userId: Bun.randomUUIDv7() }),
		);
		expect(await database.orm.select().from(deliveries)).toHaveLength(0);
		await service.enable({ ids: [hook.data.id] }, root);
		const userId = Bun.randomUUIDv7();
		await database.transaction(async (tx) => {
			await events.emit(tx, "user.created", { userId });
			await events.emit(tx, "item.created", { itemId: Bun.randomUUIDv7() });
		});
		await service.update(
			{ ids: [hook.data.id], changes: { events: ["user.deleted"] } },
			root,
		);
		await new WebhookDispatcher(database, settings).runOnce();
		expect(received).toHaveLength(1);
		expect(received[0]?.payload).toMatchObject({
			event: "user.created",
			data: { userId },
		});
	});

	test("disable and delete cancel pending work, preserve history and never cancel claimed rows", async () => {
		const first = await service.create(
			{ url: receiver.url.href, events: ["*"] },
			root,
		);
		const second = await service.create(
			{ url: receiver.url.href, events: ["*"] },
			root,
		);
		await service.enable({ ids: [first.data.id, second.data.id] }, root);
		await database.transaction((tx) =>
			events.emit(tx, "user.created", { userId: Bun.randomUUIDv7() }),
		);
		const claimedId = Bun.randomUUIDv7();
		await database.orm.insert(deliveries).values({
			id: claimedId,
			webhookId: second.data.id,
			payload: {
				id: Bun.randomUUIDv7(),
				event: "user.created",
				data: {},
				createdAt: new Date().toISOString(),
			},
			state: "claimed",
			attemptedAt: new Date(),
		});
		await service.disable({ ids: [first.data.id] }, root);
		await service.delete(
			{ ids: [second.data.id], confirm: true, reason: "Retire endpoint" },
			root,
		);
		await new WebhookDispatcher(database, settings).runOnce();
		expect(received).toHaveLength(0);
		const rows = await database.orm.select().from(deliveries);
		expect(rows.filter((row) => row.state === "cancelled")).toHaveLength(2);
		expect(rows.find((row) => row.id === claimedId)?.state).toBe("claimed");
		const history = await service.deliveryHistory(
			new URLSearchParams({ webhookId: second.data.id }),
			root,
		);
		expect(history.data).toHaveLength(2);
		if (!Array.isArray(history.data)) throw new Error("Expected history list");
		expect(Object.keys(history.data[0] ?? {}).sort()).toEqual([
			"attemptedAt",
			"createdAt",
			"error",
			"event",
			"eventId",
			"id",
			"state",
			"status",
			"webhookId",
		]);
	});

	test("history pagination remains stable and rejects invalid filters", async () => {
		const hook = await service.create(
			{ url: receiver.url.href, events: ["*"] },
			root,
		);
		await service.enable({ ids: [hook.data.id] }, root);
		for (let count = 0; count < 3; count++)
			await database.transaction((tx) => events.emit(tx, "user.created", {}));
		const first = await service.deliveryHistory(
			new URLSearchParams({
				webhookId: hook.data.id,
				limit: "2",
				state: "pending",
				direction: "asc",
			}),
			root,
		);
		expect(first.data).toHaveLength(2);
		if (!("nextCursor" in first) || !first.nextCursor)
			throw new Error("Expected cursor");
		const second = await service.deliveryHistory(
			new URLSearchParams({
				webhookId: hook.data.id,
				limit: "2",
				state: "pending",
				direction: "asc",
				cursor: first.nextCursor,
			}),
			root,
		);
		expect(second.data).toHaveLength(1);
		for (const params of [
			"webhookId=broken",
			"state=retry",
			"sort=updatedAt",
			"webhookId=x&webhookId=y",
		])
			await expect(
				service.deliveryHistory(new URLSearchParams(params), root),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});
});

describe("one-attempt delivery", () => {
	test("commits claims before sending, records 2xx/403/500/redirect status, and never follows redirects", async () => {
		for (const path of ["/success", "/denied", "/failure", "/redirect"]) {
			const hook = await service.create(
				{ url: new URL(path, receiver.url).href, events: ["*"] },
				root,
			);
			await service.enable({ ids: [hook.data.id] }, root);
		}
		await database.transaction((tx) =>
			events.emit(tx, "license.rotated", { licenseId: Bun.randomUUIDv7() }),
		);
		const dispatcher = new WebhookDispatcher(database, settings);
		await dispatcher.runOnce();
		await dispatcher.runOnce();
		expect(received).toHaveLength(4);
		expect(
			received.every(
				(request) =>
					request.claimed &&
					request.method === "POST" &&
					request.contentType === "application/json",
			),
		).toBe(true);
		expect(
			received.some((request) => request.path === "/redirect-target"),
		).toBe(false);
		const rows = await database.orm.select().from(deliveries);
		expect(rows.map((row) => row.status).sort()).toEqual([204, 302, 403, 500]);
		expect(rows.filter((row) => row.state === "succeeded")).toHaveLength(1);
		expect(rows.filter((row) => row.state === "failed")).toHaveLength(3);
		expect(
			rows.every(
				(row) => row.error === null && row.attemptedAt instanceof Date,
			),
		).toBe(true);
		expect(JSON.stringify(rows)).not.toContain("Remote secret");
		expect(JSON.stringify(rows)).not.toContain("never-save");
	});

	test("two dispatchers send each pending delivery at most once", async () => {
		const hook = await service.create(
			{ url: new URL("/success", receiver.url).href, events: ["*"] },
			root,
		);
		await service.enable({ ids: [hook.data.id] }, root);
		for (let count = 0; count < 20; count++)
			await database.transaction((tx) => events.emit(tx, "user.created", {}));
		const first = new WebhookDispatcher(database, settings);
		const second = new WebhookDispatcher(database, settings);
		await Promise.all([first.runOnce(10), second.runOnce(10)]);
		await Promise.all([first.runOnce(), second.runOnce()]);
		expect(received).toHaveLength(20);
		expect(
			new Set(received.map((request) => JSON.stringify(request.payload))).size,
		).toBe(20);
		expect(
			await database.orm
				.select()
				.from(deliveries)
				.where(eq(deliveries.state, "succeeded")),
		).toHaveLength(20);
	});

	test("disposes an unfinished streaming response without consuming it", async () => {
		const hook = await service.create(
			{ url: new URL("/stream", receiver.url).href, events: ["*"] },
			root,
		);
		await service.enable({ ids: [hook.data.id] }, root);
		await database.transaction((tx) => events.emit(tx, "user.created", {}));
		const started = performance.now();
		await new WebhookDispatcher(database, settings).runOnce();
		expect(performance.now() - started).toBeLessThan(900);
		await Promise.race([
			streamCancelled.promise,
			Bun.sleep(1000).then(() => {
				throw new Error("Response stream was not cancelled");
			}),
		]);
		expect((await database.orm.select().from(deliveries))[0]?.state).toBe(
			"succeeded",
		);
	});

	test("timeout and connection failure are sanitised terminal outcomes", async () => {
		const closed = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(),
		});
		const closedUrl = closed.url.href;
		await closed.stop(true);
		for (const url of [
			new URL("/timeout", receiver.url).href,
			closedUrl,
			"http://keyzori-fixture.invalid/",
		]) {
			const hook = await service.create({ url, events: ["*"] }, root);
			await service.enable({ ids: [hook.data.id] }, root);
		}
		await database.transaction((tx) => events.emit(tx, "user.created", {}));
		const dispatcher = new WebhookDispatcher(database, settings);
		await dispatcher.runOnce();
		await dispatcher.runOnce();
		const rows = await database.orm.select().from(deliveries);
		expect(
			rows.every((row) => row.state === "failed" && row.status === null),
		).toBe(true);
		expect(rows.map((row) => row.error).sort()).toEqual([
			"connection",
			"dns",
			"timeout",
		]);
		expect(received).toHaveLength(1);
	});

	test("live endpoint checks cancel orphaned and disabled pending rows", async () => {
		const hook = await service.create(
			{ url: receiver.url.href, events: ["*"] },
			root,
		);
		for (const webhookId of [hook.data.id, Bun.randomUUIDv7()])
			await database.orm.insert(deliveries).values({
				id: Bun.randomUUIDv7(),
				webhookId,
				payload: {
					id: Bun.randomUUIDv7(),
					event: "user.created",
					data: {},
					createdAt: new Date().toISOString(),
				},
			});
		await new WebhookDispatcher(database, settings).runOnce();
		expect(received).toHaveLength(0);
		expect(
			await database.orm
				.select()
				.from(deliveries)
				.where(eq(deliveries.state, "cancelled")),
		).toHaveLength(2);
	});

	test("shutdown stops admissions while draining claimed requests; disable leaves an in-flight attempt intact", async () => {
		const hook = await service.create(
			{ url: new URL("/hold", receiver.url).href, events: ["*"] },
			root,
		);
		await service.enable({ ids: [hook.data.id] }, root);
		await database.transaction((tx) => events.emit(tx, "user.created", {}));
		const dispatcher = new WebhookDispatcher(database, settings);
		const running = dispatcher.runOnce();
		await holdEntered.promise;
		dispatcher.stop();
		await service.disable({ ids: [hook.data.id] }, root);
		expect((await database.orm.select().from(deliveries))[0]?.state).toBe(
			"claimed",
		);
		let drained = false;
		const drain = dispatcher.drain().then(() => {
			drained = true;
		});
		await Bun.sleep(20);
		expect(drained).toBe(false);
		releaseHold.resolve();
		await Promise.all([running, drain]);
		await service.enable({ ids: [hook.data.id] }, root);
		await database.transaction((tx) => events.emit(tx, "user.created", {}));
		await dispatcher.runOnce();
		expect(received).toHaveLength(1);
		expect(
			await database.orm
				.select()
				.from(deliveries)
				.where(eq(deliveries.state, "pending")),
		).toHaveLength(1);
	});

	test("failed outcome persistence leaves a claimed record that is never automatically resent", async () => {
		const hook = await service.create(
			{ url: new URL("/success", receiver.url).href, events: ["*"] },
			root,
		);
		await service.enable({ ids: [hook.data.id] }, root);
		await database.transaction((tx) => events.emit(tx, "user.created", {}));
		await database.orm.execute(
			sql`create function reject_delivery_result() returns trigger language plpgsql as $$ begin if NEW.state in ('succeeded', 'failed') then raise exception 'Fixture settlement failure'; end if; return NEW; end; $$`,
		);
		await database.orm.execute(
			sql`create trigger reject_delivery_result before update on webhook_deliveries for each row execute function reject_delivery_result()`,
		);
		try {
			await expect(
				new WebhookDispatcher(database, settings).runOnce(),
			).rejects.toThrow();
		} finally {
			await database.orm.execute(
				sql`drop trigger reject_delivery_result on webhook_deliveries`,
			);
			await database.orm.execute(sql`drop function reject_delivery_result()`);
		}
		await new WebhookDispatcher(database, settings).runOnce();
		expect(received).toHaveLength(1);
		expect((await database.orm.select().from(deliveries))[0]?.state).toBe(
			"claimed",
		);
	});
});

describe("composed webhook routes", () => {
	test("authenticates every action and protects history under webhooks:read", async () => {
		if (!app.server) throw new Error("HTTP fixture is not listening");
		for (const [method, suffix, body] of [
			["GET", "", undefined],
			["GET", "/deliveries", undefined],
			["POST", "", { url: receiver.url.href, events: ["*"] }],
			["PATCH", "", { ids: [Bun.randomUUIDv7()], changes: {} }],
			[
				"DELETE",
				"",
				{ ids: [Bun.randomUUIDv7()], confirm: true, reason: "Delete" },
			],
			["POST", "/enable", { ids: [Bun.randomUUIDv7()] }],
			["POST", "/disable", { ids: [Bun.randomUUIDv7()] }],
		] as const) {
			const response = await fetch(
				new URL(`/webhooks${suffix}`, app.server.url),
				{
					method,
					headers: body ? { "content-type": "application/json" } : undefined,
					body: body ? JSON.stringify(body) : undefined,
				},
			);
			expect(response.status).toBe(401);
			await response.body?.cancel();
		}
		const id = Bun.randomUUIDv7();
		const key = keys.api(id);
		await database.orm.insert(apiKeys).values({
			id,
			name: "Webhook read",
			secretHash: hasher.hash(key.secret),
			enabled: true,
			scopes: ["webhooks:read"],
			createdBy: "root",
			updatedBy: "root",
		});
		for (const path of ["/webhooks", "/webhooks/deliveries"]) {
			const response = await fetch(new URL(path, app.server.url), {
				headers: { authorization: `Bearer ${key.credential}` },
			});
			expect(response.status).toBe(200);
			await response.body?.cancel();
		}
		const denied = await fetch(new URL("/webhooks", app.server.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${key.credential}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ url: receiver.url.href, events: ["*"] }),
		});
		expect(denied.status).toBe(403);
		await denied.body?.cancel();
	});

	test("strict schemas reject invented events, enabled injection, signing fields and unconfirmed deletion", async () => {
		if (!app.server) throw new Error("HTTP fixture is not listening");
		for (const [method, body] of [
			["POST", { url: receiver.url.href, events: ["invented.event"] }],
			["POST", { url: receiver.url.href, events: ["*"], enabled: true }],
			[
				"POST",
				{ url: receiver.url.href, events: ["*"], signingSecret: "never" },
			],
			["DELETE", { ids: [Bun.randomUUIDv7()], reason: "Delete" }],
		] as const) {
			const response = await fetch(new URL("/webhooks", app.server.url), {
				method,
				headers: {
					authorization: `Bearer ${master}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
			await response.body?.cancel();
		}
		const noRotate = await fetch(new URL("/webhooks/rotate", app.server.url), {
			method: "POST",
			headers: { authorization: `Bearer ${master}` },
		});
		expect(noRotate.status).toBe(404);
		await noRotate.body?.cancel();
	});
});
