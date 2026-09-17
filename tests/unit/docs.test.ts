import { expect, test } from "bun:test";
import type { OpenAPIV3 } from "openapi-types";
import { createHttp } from "../../src/application/http.ts";
import type { Services } from "../../src/application/Services.ts";
import { Config } from "../../src/shared/Config.ts";
import StripePlugin from "../../plugins/stripe/index.ts";

const config = new Config({
	KEYZORI_ADMIN_KEY: "test-key-at-least-32-characters-long",
	KEYZORI_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
	KEYZORI_REDIS_URL: "redis://127.0.0.1:1",
});
// Documentation must work before readiness without touching dependencies.
const { app } = createHttp(config, {} as Services, { ready: false });

test("OpenAPI documents every core operation with categories and preserves auth", async () => {
	const response = await app.handle(
		new Request("http://localhost/openapi.json"),
	);
	expect(response.status).toBe(200);
	const spec = (await response.json()) as OpenAPIV3.Document & {
		"x-tagGroups": { name: string; tags: string[] }[];
	};
	const groupedTags = spec["x-tagGroups"].flatMap((group) => group.tags);
	const ids = new Set<string>();
	for (const [path, item] of Object.entries(spec.paths)) {
		for (const method of ["get", "post", "put", "patch", "delete"] as const) {
			const operation = item?.[method];
			if (!operation) continue;
			expect(operation.summary?.length, `${method} ${path}`).toBeGreaterThan(5);
			expect(operation.description?.length, path).toBeGreaterThan(30);
			expect(operation.tags).toHaveLength(1);
			expect(groupedTags).toContain(operation.tags?.[0] ?? "");
			expect(operation.operationId).toBeDefined();
			expect(ids.has(operation.operationId as string)).toBe(false);
			ids.add(operation.operationId as string);
			if (path.startsWith("/admin/"))
				expect(operation.security, path).toEqual([{ adminKey: [] }]);
		}
	}
	expect(ids.size).toBe(40);
	for (const path of ["/sessions/heartbeat", "/sessions/deactivate", "/usage/"])
		expect(spec.paths[path]?.post?.security).toEqual([{ session: [] }]);
	expect(spec.paths["/sessions/"]?.post?.security ?? []).toEqual([]);
	expect(spec.paths["/health"]?.get?.security).toEqual([]);
	const terminationParameters = spec.paths["/admin/sessions/{id}/{sessionId}"]
		?.delete?.parameters as OpenAPIV3.ParameterObject[];
	const licenseIdSchema = terminationParameters.find(
		(parameter) => parameter.name === "id",
	)?.schema as OpenAPIV3.SchemaObject;
	const sessionIdSchema = terminationParameters.find(
		(parameter) => parameter.name === "sessionId",
	)?.schema as OpenAPIV3.SchemaObject;
	expect(licenseIdSchema.description).toContain("license");
	expect(sessionIdSchema.description).toContain("session ID");
	expect(spec.info.description).toContain("## Authentication");
	expect(spec.info.description).toContain("## Errors and retries");
	const body = spec.paths["/usage/"]?.post
		?.requestBody as OpenAPIV3.RequestBodyObject;
	const schema = body.content["application/json"]
		?.schema as OpenAPIV3.SchemaObject;
	expect(
		(schema.properties?.eventId as OpenAPIV3.SchemaObject | undefined)
			?.description,
	).toContain("retries");
	expect(
		(schema.properties?.units as OpenAPIV3.SchemaObject | undefined)?.minimum,
	).toBe(1);
});

test("docs serve the custom monochrome Scalar configuration without dependencies", async () => {
	const response = await app.handle(new Request("http://localhost/docs"));
	expect(response.status).toBe(200);
	const html = await response.text();
	expect(html).toContain("Keyzori API reference");
	const serialized = html.match(/data-configuration='([^']*)'/)?.[1];
	expect(serialized).toBeDefined();
	const scalar = JSON.parse(serialized as string);
	expect(scalar.theme).toBe("none");
	expect(scalar.darkMode).toBe(true);
	expect(scalar.showSidebar).toBe(true);
	expect(scalar.persistAuth).toBe(false);
	expect(scalar.customCss).toContain(".light-mode");
	expect(scalar.customCss).toContain("--scalar-background-1: #0a0a0a");
	expect(scalar.url).toBe("/openapi.json");
});

test("enabled Stripe routes retain summaries, categories, and separate authentication", async () => {
	const { app: pluginApp, guard } = createHttp(
		new Config({ ...config.env, KEYZORI_PLUGINS: "stripe" }),
		{} as Services,
		{
			ready: false,
		},
	);
	pluginApp.use(
		new StripePlugin().create({
			adminGuard: guard,
			env: {
				KEYZORI_STRIPE_SECRET_KEY: "sk_test_docsfixture",
				KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_docsfixture",
			},
		} as unknown as Parameters<StripePlugin["create"]>[0]),
	);
	const response = await pluginApp.handle(
		new Request("http://localhost/openapi.json"),
	);
	expect(response.status).toBe(200);
	const spec = (await response.json()) as OpenAPIV3.Document;
	let count = 0;
	for (const [path, item] of Object.entries(spec.paths)) {
		if (!path.startsWith("/plugins/stripe/")) continue;
		for (const method of ["get", "post", "delete"] as const) {
			const operation = item?.[method];
			if (!operation) continue;
			count++;
			expect(operation.tags).toEqual(["stripe"]);
			expect(operation.summary?.length).toBeGreaterThan(5);
			expect(operation.description?.length).toBeGreaterThan(30);
			expect(operation.security).toEqual(
				path.includes("/admin/") ? [{ adminKey: [] }] : [],
			);
		}
	}
	expect(count).toBe(7);
	expect(Reflect.get(spec, "x-tagGroups")).toContainEqual({
		name: "Plugins",
		tags: ["stripe"],
	});
});
