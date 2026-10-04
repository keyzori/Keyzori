import { afterAll, beforeAll, expect, test } from "bun:test";
import { TestHttp } from "../fixtures/TestHttp";

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
			body: { name: scope, scopes: [scope] },
		});
		const issued = await response.json();
		assign(issued.credential);
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
	const issued = await created.json();
	licenceCredential = issued.credential;
	await context.request("/licenses/enable", {
		method: "POST",
		body: { ids: [issued.data.id] },
	});
});
afterAll(() => context.stop());

test("every protected method rejects anonymous, unrelated scopes and licence mutations", async () => {
	const id = Bun.randomUUIDv7();
	let checked = 0;
	for (const route of context.app.routes) {
		if (["/health", "/validate"].includes(route.path)) continue;
		let body: Record<string, unknown> | undefined;
		if (route.method !== "GET") {
			if (route.method === "DELETE")
				body = { ids: [id], confirm: true, reason: "test" };
			else if (route.path === "/settings") body = { changes: {} };
			else if (route.method === "PATCH") body = { ids: [id], changes: {} };
			else if (route.path === "/licenses/meters/adjust")
				body = { ids: [id], name: "use", action: "reset" };
			else if (route.path === "/licenses/hardware/remove")
				body = { ids: [id], hardwareIds: ["device"] };
			else if (route.path === "/licenses/ips/remove")
				body = { ids: [id], ips: ["127.0.0.1"] };
			else if (route.path.split("/").length > 2) body = { ids: [id] };
			else if (route.path === "/licenses") body = {};
			else if (route.path === "/api-keys")
				body = { name: "test", scopes: ["users:read"] };
			else if (route.path === "/webhooks")
				body = { url: "http://127.0.0.1", events: ["*"] };
			else body = { name: "test" };
		}
		const options = {
			method: route.method,
			body,
			headers: { "Idempotency-Key": Bun.randomUUIDv7() },
		};
		expect(
			(await context.request(route.path, { ...options, credential: null }))
				.status,
			`${route.method} ${route.path} anonymous`,
		).toBe(401);
		const wrongScope =
			route.path === "/licenses" && route.method === "GET"
				? userReader
				: licenceReader;
		expect(
			(
				await context.request(route.path, {
					...options,
					credential: wrongScope,
				})
			).status,
			`${route.method} ${route.path} scope`,
		).toBe(403);
		if (route.path !== "/licenses/self")
			expect(
				(
					await context.request(route.path, {
						...options,
						credential: licenceCredential,
					})
				).status,
				`${route.method} ${route.path} licence`,
			).toBe(403);
		checked++;
	}
	expect(checked).toBe(40);
});
