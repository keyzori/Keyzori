import { openapi } from "@elysia/openapi";
import app from "./capture";
import { version } from "../version";
import { httpModel, metadataDefinitions } from "../core/http/model";

app.model(metadataDefinitions);
app.use(
	openapi({
		path: "/__build_docs",
		specPath: "/__build_openapi",
		documentation: {
			info: {
				title: "Keyzori",
				version,
				description:
					"Hash-only licensing. All resources start disabled. Root controls API keys, settings and metrics. Successful secret issuance is not replayable.",
			},
			components: {
				securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
				schemas: { Error: httpModel.error },
			},
		},
	}),
);
const response = await app.handle(
	new Request("http://build.local/__build_openapi"),
);
if (!response.ok) throw new Error("OpenAPI capture failed");
const specification = await response.json();
if (
	!specification.paths?.["/validate"]?.post ||
	specification.paths["/__build_openapi"]
)
	throw new Error("Unexpected OpenAPI route graph");
for (const [path, methods] of Object.entries(specification.paths)) {
	if (!methods || typeof methods !== "object")
		throw new Error("Invalid captured path");
	for (const [method, operation] of Object.entries(methods)) {
		if (!operation || typeof operation !== "object")
			throw new Error("Invalid captured operation");
		if (
			!("responses" in operation) ||
			!operation.responses ||
			typeof operation.responses !== "object"
		)
			throw new Error("Missing captured responses");
		Object.assign(
			operation.responses,
			Object.fromEntries(
				[400, 401, 403, 404, 409, 413, 415, 429, 500, 503]
					.filter((status) => !Object.hasOwn(operation.responses, status))
					.map((status) => [
						status,
						{
							description: "Request failed",
							content: {
								"application/json": {
									schema: { $ref: "#/components/schemas/Error" },
								},
							},
						},
					]),
			),
		);
		if (
			method === "get" &&
			["/licenses", "/users", "/items", "/api-keys"].includes(path)
		) {
			const fields = [
				"id",
				"limit",
				"cursor",
				"sort",
				"direction",
				"enabled",
				"search",
				"createdBefore",
				"createdAfter",
			];
			if (["/licenses", "/api-keys"].includes(path))
				fields.push("hasExpiry", "expiresBefore", "expiresAfter");
			if (path === "/licenses")
				fields.push("hasDeviceLimit", "userId", "itemId");
			Object.assign(operation, {
				parameters: fields.map((name) => ({
					in: "query",
					name,
					required: false,
					schema: { type: "string" },
				})),
				description:
					"Single reads use id. Lists default to limit=10, createdAt descending, with a stable nextCursor. Keep sort/direction on cursor requests. Filters are ANDed. Metadata-enabled resources accept metadata.<name> for top-level strings and metadataNumber.<name> for top-level numbers. Names are literal keys; nested values, arrays, booleans and null are not filterable. Licence principals require their exact own or related ID and cannot list.",
			});
		}
		if (path === "/metrics")
			Object.assign(operation, { "x-required-scope": "root" });
		if (["post", "patch", "delete"].includes(method))
			Object.assign(operation, {
				parameters: [
					{
						in: "header",
						name: "Idempotency-Key",
						required:
							method === "post" &&
							(["/licenses", "/api-keys"].includes(path) ||
								path.endsWith("/rotate")),
						description:
							path === "/validate"
								? "Required when usage is non-empty; the request and effective IP must match on replay."
								: "Required for secret issuance. Optional for other mutations. Conflicting reuse is rejected.",
						schema: { type: "string", minLength: 1, maxLength: 256 },
					},
				],
			});
	}
}
const references = (value: unknown) => {
	if (!value || typeof value !== "object") return;
	if ("$ref" in value && typeof value.$ref === "string") {
		if (!value.$ref.startsWith("#/"))
			throw new Error("External schema reference");
		let target: unknown = specification;
		for (const part of value.$ref.slice(2).split("/")) {
			const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
			if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
				throw new Error(`Unresolved schema reference: ${value.$ref}`);
			target = (target as Record<string, unknown>)[key];
		}
	}
	for (const child of Object.values(value)) references(child);
};
references(specification);
await Bun.write(
	"dist/server/openapi.json",
	`${JSON.stringify(specification, null, 2)}\n`,
);
console.log(
	`Captured ${Object.keys(specification.paths).length} OpenAPI paths without runtime services`,
);
