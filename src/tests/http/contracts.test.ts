import { afterAll, beforeAll, expect, test } from "bun:test";
import { TestHttp } from "../fixtures/TestHttp";
import { checkedJSON } from "../fixtures/Json";
import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { validationModel } from "../../plugins/validate/model";

const issuedModel = t.Object({
	ok: t.Literal(true),
	data: t.Object({
		id: httpModel.id,
		credential: t.String(),
		enabled: t.Boolean(),
	}),
});
const pageModel = t.Object({
	meta: t.Object({ page: t.Object({ limit: t.Integer() }) }),
});

const context = new TestHttp();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("JSON success, denial and errors use one contract with correlation", async () => {
	const health = await context.request("/health", { credential: null });
	expect(health.status).toBe(200);
	expect(await health.json()).toMatchObject({
		ok: true,
		error: null,
		data: { healthy: true, postgresql: true, redis: true },
	});
	const missing = await context.request("/unknown");
	expect(missing.status).toBe(404);
	expect(await missing.json()).toMatchObject({
		ok: false,
		data: null,
		error: { code: "NOT_FOUND", retryable: false },
		meta: { requestId: missing.headers.get("x-request-id") },
	});
	const denied = await context.request("/validate", {
		method: "POST",
		credential: null,
		body: { license: "unknown" },
	});
	expect(denied.status).toBe(200);
	expect(await denied.json()).toMatchObject({
		ok: true,
		error: null,
		data: { valid: false, code: "LICENSE_INVALID", license: null },
	});
	const unauthorized = await context.request("/licenses", { credential: null });
	expect(unauthorized.status).toBe(401);
	expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
	expect(unauthorized.headers.get("cache-control")).toBe("no-store");
});

test("secrets are one-time and licence possession grants validation only", async () => {
	const options = {
		method: "POST",
		body: { metadata: { association: "account-42" } },
		headers: { "Idempotency-Key": Bun.randomUUIDv7() },
	};
	const created = await context.request("/licenses", options);
	const result = await checkedJSON(created, issuedModel);
	expect(result.ok).toBe(true);
	expect(result.data.credential).toBeString();
	expect(result.data.enabled).toBe(false);
	const replay = await context.request("/licenses", options);
	expect(replay.status).toBe(409);
	const replayBody = await checkedJSON(
		replay,
		t.Object({ error: t.Object({ resourceIds: t.Array(httpModel.id) }) }),
	);
	expect(replayBody.error.resourceIds).toEqual([result.data.id]);
	expect(JSON.stringify(replayBody)).not.toContain(result.data.credential);
	expect(
		(await context.request("/licenses", { credential: result.data.credential }))
			.status,
	).toBe(401);
	const validate = await context.request("/validate", {
		method: "POST",
		credential: null,
		body: { license: result.data.credential },
	});
	const decision = await checkedJSON(
		validate,
		t.Object({ data: validationModel.response.properties.data }),
	);
	expect(decision.data.valid).toBe(false);
	expect(decision.data.license?.metadata).toEqual({
		association: "account-42",
	});
	expect(JSON.stringify(decision)).not.toContain("keyHash");
	expect(JSON.stringify(decision)).not.toContain(result.data.credential);
});

test("page metadata reports configured defaults and explicit request limits", async () => {
	expect(
		(
			await context.request("/settings", {
				method: "PATCH",
				body: { changes: { defaultPageLimit: 7 } },
			})
		).status,
	).toBe(200);
	try {
		for (const path of [
			"/licenses",
			"/groups",
			"/users",
			"/api-keys",
			"/webhooks",
		]) {
			const defaults = await context.request(path);
			expect(defaults.status, path).toBe(200);
			expect(
				(await checkedJSON(defaults, pageModel)).meta.page.limit,
				path,
			).toBe(7);
			const explicit = await context.request(`${path}?limit=3`);
			expect(explicit.status, path).toBe(200);
			expect(
				(await checkedJSON(explicit, pageModel)).meta.page.limit,
				path,
			).toBe(3);
		}
	} finally {
		await context.request("/settings", {
			method: "PATCH",
			body: { changes: { defaultPageLimit: 50 } },
		});
	}
});

test("new API keys have no grants, reject metadata and cannot grant themselves authority", async () => {
	for (const body of [
		{ name: "bad", scopes: ["licenses:read"] },
		{ name: "bad", metadata: {} },
	]) {
		expect(
			(
				await context.request("/api-keys", {
					method: "POST",
					body,
					headers: { "Idempotency-Key": Bun.randomUUIDv7() },
				})
			).status,
		).toBe(400);
	}
	const created = await context.request("/api-keys", {
		method: "POST",
		body: { name: "empty" },
		headers: { "Idempotency-Key": Bun.randomUUIDv7() },
	});
	const key = (
		await checkedJSON(
			created,
			t.Object({
				data: t.Object({
					id: httpModel.id,
					credential: t.String(),
					scopes: t.Array(t.String()),
					allGroups: t.Boolean(),
				}),
			}),
		)
	).data;
	expect(key.scopes).toEqual([]);
	expect(key.allGroups).toBe(false);
	await context.request("/api-keys/enable", {
		method: "POST",
		body: { ids: [key.id] },
	});
	for (const path of [
		"/licenses",
		"/groups",
		"/users",
		"/events",
		"/audits",
		"/api-keys",
		"/settings",
		"/metrics",
	]) {
		expect(
			(await context.request(path, { credential: key.credential })).status,
			path,
		).toBe(403);
	}
	const patch = {
		method: "PATCH",
		body: {
			ids: [key.id],
			changes: { scopes: ["licenses:read"], allGroups: true },
		},
	};
	expect(
		(
			await context.request("/api-keys", {
				...patch,
				credential: key.credential,
			})
		).status,
	).toBe(403);
	expect((await context.request("/api-keys", patch)).status).toBe(200);
	expect(
		(await context.request("/licenses", { credential: key.credential })).status,
	).toBe(200);
	const listing = await (await context.request("/api-keys")).text();
	expect(listing).not.toContain(context.master);
	expect(listing).not.toContain(key.credential);
	expect(listing).not.toContain("secretHash");
});

test("invalid fields and body types fail without echoing secrets", async () => {
	for (const body of [
		{ license: "SENSITIVE", extra: 1 },
		{ license: 42 },
		{ license: "SENSITIVE", usage: { requests: "1" } },
	]) {
		const response = await context.request("/validate", {
			method: "POST",
			body,
			credential: null,
		});
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("SENSITIVE");
	}
	const media = await fetch(new URL("/validate", context.app.server?.url), {
		method: "POST",
		headers: { "content-type": "text/plain" },
		body: "secret",
	});
	expect(media.status).toBe(415);
	const oversized = await fetch(new URL("/validate", context.app.server?.url), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ license: "x".repeat(1048576) }),
	});
	expect(oversized.status).toBe(413);
	expect((await context.request("/licenses?limit=101")).status).toBe(400);
	expect(
		(
			await context.request("/licenses/disable", {
				method: "POST",
				body: { ids: Array.from({ length: 101 }, () => Bun.randomUUIDv7()) },
			})
		).status,
	).toBe(400);
});

test("CORS is dynamic, limited to public validation, and never substitutes authentication", async () => {
	await context.request("/settings", {
		method: "PATCH",
		body: { changes: { corsOrigins: ["https://client.example"] } },
	});
	const options = {
		method: "OPTIONS",
		credential: null,
		headers: { Origin: "https://client.example" },
	};
	const preflight = await context.request("/validate", options);
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("access-control-allow-origin")).toBe(
		"https://client.example",
	);
	expect(
		(
			await context.request("/users", {
				credential: null,
				headers: options.headers,
			})
		).status,
	).toBe(401);
	await context.request("/settings", {
		method: "PATCH",
		body: { changes: { corsOrigins: [] } },
	});
	expect(
		(await context.request("/validate", options)).headers.get(
			"access-control-allow-origin",
		),
	).toBeNull();
});
