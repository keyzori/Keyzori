import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";

describe.skipIf(!integrationAvailable)("core HTTP", () => {
	let ctx: TestContext;
	beforeAll(async () => {
		ctx = await new TestContext().start();
	});
	afterAll(async () => {
		await ctx?.close();
	});
	test("every core admin feature rejects missing and wrong admin keys", async () => {
		for (const route of [
			"/admin/customers",
			"/admin/licenses",
			`/admin/access/${crypto.randomUUID()}`,
			`/admin/sessions?licenseId=${crypto.randomUUID()}`,
			`/admin/meters?licenseId=${crypto.randomUUID()}`,
			`/admin/usage?licenseId=${crypto.randomUUID()}`,
			"/admin/activity",
		]) {
			for (const headers of [{}, { "X-Admin-Key": "wrong" }] as Record<
				string,
				string
			>[])
				expect(
					(await ctx.request(route, "GET", undefined, headers)).status,
				).toBe(401);
		}
	});
	test("customer CRUD, bounded pages, strict body/query/parameter errors", async () => {
		const created = await ctx.request("/admin/customers", "POST", {
			email: "API@EXAMPLE.COM",
			name: "API",
			metadata: { secret: "hidden" },
		});
		expect(created.status).toBe(201);
		expect(created.body.email).toBe("api@example.com");
		expect(created.body.metadata.secret).toBe("[REDACTED]");
		expect(
			(
				await ctx.request("/admin/customers", "POST", {
					email: "api@example.com",
					name: "Duplicate",
				})
			).status,
		).toBe(409);
		expect(
			(
				await ctx.request("/admin/licenses", "POST", {
					customerId: crypto.randomUUID(),
					config: { type: "lifetime" },
				})
			).status,
		).toBe(409);
		expect(
			(
				await ctx.request(`/admin/customers/${created.body.id}`, "PUT", {
					email: "updated@example.com",
					name: "Updated",
				})
			).status,
		).toBe(200);
		expect(
			(await ctx.request("/admin/customers?limit=1")).body.items,
		).toHaveLength(1);
		expect((await ctx.request("/admin/customers?limit=101")).status).toBe(400);
		expect((await ctx.request("/admin/customers?unexpected=yes")).status).toBe(
			422,
		);
		expect((await ctx.request("/admin/customers/not-a-uuid")).status).toBe(422);
		const invalid = await ctx.request("/admin/customers", "POST", {
			email: "x@example.com",
			name: "Name",
			key: "secret",
		});
		expect(invalid.status).toBe(422);
		expect(invalid.body).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "Request does not match the documented schema.",
			},
		});
		expect(
			(await ctx.request(`/admin/customers/${created.body.id}`, "DELETE"))
				.status,
		).toBe(200);
		expect(
			(await ctx.request(`/admin/customers/${created.body.id}`)).status,
		).toBe(404);
	});
	test("all four types and session runtime HTTP flow", async () => {
		for (const type of [
			"lifetime",
			"subscription",
			"metered",
			"trial",
		] as const) {
			const customer = await ctx.customer();
			const config =
				type === "trial"
					? { type, durationSeconds: 60 }
					: type === "subscription"
						? { type, expiresAt: new Date(Date.now() + 86400000).toISOString() }
						: { type };
			const created = await ctx.request("/admin/licenses", "POST", {
				customerId: customer.id,
				config,
			});
			expect(created.status).toBe(201);
			expect(created.body.keyHash).toBeUndefined();
			expect(created.body.key).toStartWith("lic_");
			const fetched = await ctx.request(`/admin/licenses/${created.body.id}`);
			expect(fetched.body.key).toBeUndefined();
			expect(fetched.body.keyHash).toBeUndefined();
			const activation = await ctx.request(
				"/sessions",
				"POST",
				{ key: created.body.key, deviceId: "http-device" },
				{},
			);
			expect(activation.status).toBe(200);
			const headers = {
				Authorization: `Bearer ${activation.body.token}`,
				"X-Device-Id": "http-device",
			};
			expect(
				(await ctx.request("/sessions/heartbeat", "POST", {}, headers)).status,
			).toBe(200);
			expect(
				(
					await ctx.request(
						"/sessions/heartbeat",
						"POST",
						{},
						{ ...headers, "X-Device-Id": "wrong" },
					)
				).status,
			).toBe(401);
			if (type === "metered") {
				const meter = await ctx.request("/admin/meters", "POST", {
					licenseId: created.body.id,
					name: "exports",
					limit: 10,
				});
				expect(meter.status).toBe(201);
				const usage = await ctx.request(
					"/usage",
					"POST",
					{ meter: "exports", units: 3, eventId: "event" },
					headers,
				);
				expect(usage.status).toBe(200);
				expect(usage.body.remaining).toBe(7);
				expect(
					(await ctx.request(`/admin/usage?licenseId=${created.body.id}`)).body
						.items,
				).toHaveLength(1);
			}
			expect(
				(await ctx.request("/sessions/deactivate", "POST", {}, headers)).status,
			).toBe(200);
			expect(
				(await ctx.request("/sessions/heartbeat", "POST", {}, headers)).status,
			).toBe(401);
		}
	});
	test("OpenAPI covers routes, request/response schemas, and authentication", async () => {
		const spec = await ctx.request("/openapi.json");
		expect(spec.status).toBe(200);
		for (const route of ctx.app.app.routes) {
			if (["/docs", "/openapi.json"].includes(route.path)) continue;
			const path = route.path.replace(/:([^/]+)/g, "{$1}").replace(/\/$/, "");
			expect(
				spec.body.paths[path] ?? spec.body.paths[`${path}/`],
			).toBeDefined();
		}
		expect(
			spec.body.paths["/sessions/"].post.requestBody.content["application/json"]
				.schema.properties.key,
		).toBeDefined();
		expect(
			spec.body.paths["/sessions/"].post.responses["200"].content[
				"application/json"
			].schema.properties.token,
		).toBeDefined();
		expect(
			spec.body.paths["/admin/licenses/"].post.responses["201"].content[
				"application/json"
			].schema.properties.key,
		).toBeDefined();
		expect(spec.body.paths["/admin/licenses/"].get.security).toEqual([
			{ adminKey: [] },
		]);
		expect(spec.body.paths["/sessions/heartbeat"].post.security).toEqual([
			{ session: [] },
		]);
		expect(spec.body.components.schemas.Error.properties.error).toBeDefined();
		expect((await fetch(`${ctx.url}/docs`)).status).toBe(200);
		expect((await ctx.request("/health")).status).toBe(200);
		expect((await ctx.request("/ready")).status).toBe(200);
	});
	test("repeated startup preserves schema and data", async () => {
		const customer = await ctx.customer();
		await ctx.restart();
		expect((await ctx.request(`/admin/customers/${customer.id}`)).status).toBe(
			200,
		);
	});
});
