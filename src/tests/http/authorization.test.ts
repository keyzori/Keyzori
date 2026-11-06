import { afterAll, beforeAll, expect, test } from "bun:test";
import { TestHttp } from "../fixtures/TestHttp";
import { checkedJSON } from "../fixtures/Json";
import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { operationFor } from "../../core/http/operations";

const issuedModel = t.Object({
	data: t.Object({ id: httpModel.id, credential: t.String() }),
});

const context = new TestHttp();
let licenceCredential = "";
let licenceReader = "";
let userReader = "";
beforeAll(async () => {
	await context.start();
	for (const [scope, assign] of [
		[
			"licenses:read",
			(credential: string) => {
				licenceReader = credential;
			},
		],
		[
			"users:read",
			(credential: string) => {
				userReader = credential;
			},
		],
	] as const) {
		const response = await context.request("/api-keys", {
			method: "POST",
			headers: { "Idempotency-Key": Bun.randomUUIDv7() },
			body: { name: scope },
		});
		const issued = await checkedJSON(response, issuedModel);
		assign(issued.data.credential);
		await context.request("/api-keys", {
			method: "PATCH",
			body: {
				ids: [issued.data.id],
				changes: { scopes: [scope], allGroups: true },
			},
		});
		await context.request("/api-keys/enable", {
			method: "POST",
			body: { ids: [issued.data.id] },
		});
	}
	const created = await context.request("/licenses", {
		method: "POST",
		headers: { "Idempotency-Key": Bun.randomUUIDv7() },
		body: {},
	});
	const issued = await checkedJSON(created, issuedModel);
	licenceCredential = issued.data.credential;
	await context.request("/licenses/enable", {
		method: "POST",
		body: { ids: [issued.data.id] },
	});
});
afterAll(() => context.stop());

test("every protected method rejects anonymous, unrelated scopes and licence mutations", async () => {
	const id = Bun.randomUUIDv7();
	let checked = 0;
	const protectedRoutes = context.app.routes.filter((route) => {
		const policy = operationFor(route.method, route.path);
		if (!policy) throw new Error(`Missing operation policy: ${route.path}`);
		return policy.access !== "public" && route.path !== "/events/stream";
	});
	for (const route of protectedRoutes) {
		const path = route.path.replace(":id", id);
		let body: Record<string, unknown> | undefined;
		if (route.method !== "GET") {
			if (route.method === "DELETE")
				body = { ids: [id], confirm: true, reason: "test" };
			else if (route.path === "/settings") body = { changes: {} };
			else if (route.method === "PATCH")
				body = {
					ids: [id],
					changes:
						route.path === "/licenses"
							? { notes: "test" }
							: route.path === "/webhooks"
								? { url: "https://example.com/hook" }
								: { name: "test" },
				};
			else if (route.path === "/licenses/consume")
				body = { licenseId: id, usage: { use: "1" } };
			else if (route.path === "/licenses/hardware/register")
				body = { licenseId: id, hardwareId: "device" };
			else if (route.path === "/licenses/ips/register")
				body = { licenseId: id };
			else if (route.path === "/licenses/meters/adjust")
				body = { ids: [id], name: "use", action: "reset" };
			else if (route.path === "/licenses/hardware/remove")
				body = { ids: [id], hardwareIds: ["device"] };
			else if (route.path === "/licenses/ips/remove")
				body = { ids: [id], ips: ["127.0.0.1"] };
			else if (route.path.split("/").length > 2) body = { ids: [id] };
			else if (route.path === "/licenses") body = {};
			else if (route.path === "/api-keys") body = { name: "test" };
			else if (route.path === "/webhooks")
				body = {
					url: "https://example.com/hook",
					events: ["license.created"],
					allGroups: true,
				};
			else body = { name: "test" };
		}
		const options = {
			method: route.method,
			body,
			headers: { "Idempotency-Key": Bun.randomUUIDv7() },
		};
		expect(
			(await context.request(path, { ...options, credential: null })).status,
			`${route.method} ${route.path} anonymous`,
		).toBe(401);
		const wrongScope =
			operationFor(route.method, route.path)?.access === "licenses:read"
				? userReader
				: licenceReader;
		expect(
			(
				await context.request(path, {
					...options,
					credential: wrongScope,
				})
			).status,
			`${route.method} ${route.path} scope`,
		).toBe(403);
		expect(
			(
				await context.request(path, {
					...options,
					credential: licenceCredential,
				})
			).status,
			`${route.method} ${route.path} licence`,
		).toBe(401);
		checked++;
	}
	expect(checked).toBe(protectedRoutes.length);
});

test("ordinary JSON responses retain their contract with a spoofed upgrade header", async () => {
	const response = await context.request("/licenses", {
		headers: { Upgrade: "websocket" },
	});
	expect(response.status).toBe(200);
	const body = await checkedJSON(
		response,
		t.Object({
			ok: t.Literal(true),
			data: t.Array(t.Object({ id: httpModel.id })),
			error: t.Null(),
			meta: t.Object({ requestId: t.String() }),
		}),
	);
	expect(body.data.length).toBeGreaterThan(0);
});

test("resource collections have stable array shapes and details use path IDs", async () => {
	const response = await context.request("/licenses");
	const body = await checkedJSON(
		response,
		t.Object({ data: t.Array(t.Object({ id: httpModel.id })) }),
	);
	const first = body.data[0];
	if (!first) throw new Error("Expected licence fixture");
	expect((await context.request(`/licenses?id=${first.id}`)).status).toBe(400);
	expect((await context.request(`/licenses/${first.id}`)).status).toBe(200);
});
