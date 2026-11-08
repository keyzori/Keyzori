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
	const events = object(object(paths["/events"]).get);
	expect(object(paths["/events/stream"]).ws).toBeUndefined();
	expect(
		object(object(object(paths["/events/stream"]).get).responses)["101"],
	).toBeDefined();
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
