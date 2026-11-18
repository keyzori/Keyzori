import { expect, test } from "bun:test";
import { command } from "../../scripts/command";
import { operations } from "../../core/http/operations";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected reference object");
	return Object.fromEntries(Object.entries(value));
}

test("offline OpenAPI preserves registry authority, mandatory idempotency and exact collection query bounds", async () => {
	await command([process.execPath, "--no-env-file", "src/scripts/openapi.ts"], {
		env: {
			...Bun.env,
			KZ_DATABASE_URL: "invalid",
			KZ_REDIS_URL: "invalid",
			KZ_MASTER_KEY: "invalid",
		},
	});
	const specification = object(
		await Bun.file("dist/server/openapi.json").json(),
	);
	const paths = object(specification.paths);
	for (const contract of operations) {
		// The runtime deliberately marks browser CORS preflight as hidden.
		if (contract.method === "OPTIONS") continue;
		const path = contract.path.replace(/:([^/]+)/g, "{$1}");
		const method = contract.method.toLowerCase();
		const operation = object(object(paths[path])[method]);
		expect(operation["x-required-access"]).toBe(contract.access);
		expect(operation.security).toEqual(
			contract.access === "public" ? [] : [{ bearerAuth: [] }],
		);
		if (["POST", "PATCH", "DELETE"].includes(contract.method)) {
			const requestBody = object(operation.requestBody);
			expect(requestBody.required).toBe(true);
			const content = object(requestBody.content);
			expect(Object.keys(content)).toEqual(["application/json"]);
			expect(
				Object.keys(object(object(content["application/json"]).schema)).length,
			).toBeGreaterThan(0);
		}
		const parameters = Array.isArray(operation.parameters)
			? operation.parameters.map(object)
			: [];
		if (contract.idempotency)
			expect(
				parameters.find((parameter) => parameter.name === "Idempotency-Key"),
			).toMatchObject({
				in: "header",
				required: contract.idempotency === "required",
			});
		if (["resource", "audits", "deliveries"].includes(contract.query ?? "")) {
			expect(
				parameters.find((parameter) => parameter.name === "cursor"),
			).toMatchObject({ schema: { maxLength: 1024 } });
			expect(
				parameters.find((parameter) => parameter.name === "limit"),
			).toMatchObject({ schema: { minimum: 1, maximum: 100 } });
		}
		if (contract.query === "resource" || contract.query === "deliveries")
			expect(parameters.some((parameter) => parameter.name === "id")).toBe(
				false,
			);
	}
	const requestSchema = (path: string) => {
		const operation = object(object(paths[path]).post);
		const media = object(object(operation.requestBody).content);
		return object(object(media["application/json"]).schema);
	};
	expect(requestSchema("/validate").required).toEqual(["license"]);
	const adjustment = requestSchema("/licenses/meters/adjust");
	expect(adjustment.required).toContain("action");
	expect(object(adjustment.properties).action).not.toHaveProperty("default");
	expect(object(requestSchema("/licenses").properties).metadata).toMatchObject({
		$ref: "#/components/schemas/Metadata",
	});
	expect(requestSchema("/licenses/hardware/register").required).toEqual(
		expect.arrayContaining(["licenseId", "hardwareId"]),
	);
	expect(requestSchema("/licenses/ips/register").required).toEqual(
		expect.arrayContaining(["licenseId", "ip"]),
	);
	expect(object(object(paths["/groups"]).delete)["x-required-scopes"]).toEqual([
		"groups:delete",
		"licenses:disable",
	]);
	expect(
		object(object(paths["/webhooks/deliveries"]).get)["x-required-scopes"],
	).toEqual(["webhooks:read", "events:read"]);
	expect(
		object(object(object(paths["/live"]).get).responses)["200"],
	).toBeDefined();
	expect(
		object(object(specification.webhooks).integrationEvent).post,
	).toBeDefined();
	const events = object(object(paths["/events"]).get);
	expect(object(paths["/events/stream"]).ws).toBeUndefined();
	expect(
		object(object(object(paths["/events/stream"]).get).responses)["101"],
	).toBeDefined();
	expect(
		object(object(paths["/events/stream"]).get)["x-websocket-server-frame"],
	).toEqual({ $ref: "#/components/schemas/ActivityServerFrame" });
	expect(events.parameters).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: "cursor",
				schema: { type: "string", maxLength: 512 },
			}),
		]),
	);
	const audits = object(object(paths["/audits"]).get);
	expect(audits.description).not.toContain("selects a single resource");
});
