import { toOpenAPISchema } from "@elysia/openapi";
import app from "./reference-app";
import { version } from "../version";
import { metadataDefinitions } from "../core/http/model";
import { errors } from "../core/http/errors";
import { operationFor } from "../core/http/operations";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid OpenAPI object");
	return Object.fromEntries(Object.entries(value));
}
const meta = {
	type: "object",
	required: ["requestId"],
	properties: {
		requestId: { type: "string" },
		page: {
			type: "object",
			required: ["limit", "nextCursor", "hasMore"],
			properties: {
				limit: { type: "integer", minimum: 1, maximum: 100 },
				nextCursor: { type: ["string", "null"] },
				hasMore: { type: "boolean" },
			},
		},
		operation: {
			type: "object",
			required: ["replayed"],
			properties: { replayed: { type: "boolean" } },
		},
	},
};
const errorSchema = {
	type: "object",
	required: ["ok", "data", "error", "meta"],
	additionalProperties: false,
	properties: {
		ok: { const: false },
		data: { type: "null" },
		meta,
		error: {
			type: "object",
			required: ["code", "message", "retryable"],
			additionalProperties: false,
			properties: {
				code: { type: "string", enum: Object.keys(errors) },
				message: { type: "string" },
				retryable: { type: "boolean" },
				resourceIds: {
					type: "array",
					items: { type: "string", format: "uuid" },
				},
				details: {
					type: "array",
					maxItems: 16,
					items: {
						type: "object",
						properties: {
							path: { type: "string" },
							message: { type: "string" },
						},
						required: ["path", "message"],
					},
				},
			},
		},
	},
};
function payload(schema: unknown): unknown {
	const value = object(schema);
	if (Array.isArray(value.anyOf)) return { anyOf: value.anyOf.map(payload) };
	if (Array.isArray(value.oneOf)) return { oneOf: value.oneOf.map(payload) };
	if (!value.properties || typeof value.properties !== "object") return value;
	const properties = object(value.properties);
	if (!properties.data) return value;
	if (!properties.credential && !properties.secret) return properties.data;
	const data = object(properties.data);
	return {
		...data,
		properties: {
			...object(data.properties),
			...(properties.credential ? { credential: properties.credential } : {}),
			...(properties.secret ? { secret: properties.secret } : {}),
		},
		required: [
			...(Array.isArray(data.required) ? data.required : []),
			...(properties.credential ? ["credential"] : []),
			...(properties.secret ? ["secret"] : []),
		],
	};
}
function envelope(schema: unknown) {
	return {
		type: "object",
		required: ["ok", "data", "error", "meta"],
		additionalProperties: false,
		properties: {
			ok: { const: true },
			data: payload(schema),
			error: { type: "null" },
			meta,
		},
	};
}

app.model(metadataDefinitions);
// Read schemas directly; no synthetic HTTP route bypasses the operation registry.
const generated = toOpenAPISchema(
	app,
	{ methods: [] },
	undefined,
	undefined,
	"3.1.0",
);
const specification: ObjectValue = {
	openapi: "3.1.0",
	info: {
		title: "Keyzori",
		version,
		description:
			"Internal developer licence-key management. Licence-key-only validation exposes licence-domain data, linked group/user metadata and registered identities, excluding administrative notes at every level. Consumption requires a permissioned API key. API keys start with no permissions. Secrets are disclosed only once.",
	},
	paths: generated.paths,
	components: {
		...generated.components,
		securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
	},
};
const components = object(specification.components);
components.schemas = {
	...(components.schemas ? object(components.schemas) : {}),
	ApiError: errorSchema,
};
specification.components = components;
const paths = object(specification.paths);
if (!paths["/validate"] || paths["/__reference_openapi"])
	throw new Error("Unexpected OpenAPI route graph");
for (const [path, methods] of Object.entries(paths)) {
	const route = object(methods);
	// Elysia emits its internal `ws` method. Describe the HTTP upgrade and retain
	// frame metadata as an extension instead of publishing an invalid HTTP verb.
	if (route.ws) {
		const stream = object(route.ws);
		stream["x-websocket-message"] = stream.requestBody;
		delete stream.requestBody;
		stream.responses = {
			101: {
				description:
					"WebSocket upgrade. Authenticate via Authorization, then send one subscribe frame after ready. Subsequent frames use the activity protocol, not the HTTP envelope.",
			},
		};
		route.get = stream;
		delete route.ws;
	}
	for (const [method, value] of Object.entries(route)) {
		if (
			!["get", "post", "patch", "delete", "put", "options", "head"].includes(
				method,
			)
		)
			continue;
		const operation = object(value);
		const contract = operationFor(method.toUpperCase(), path);
		if (!contract)
			throw new Error(`Undeclared reference operation: ${method} ${path}`);
		operation.security =
			contract.access === "public" ? [] : [{ bearerAuth: [] }];
		operation["x-required-access"] = contract.access;
		if (contract.access !== "public" && contract.access !== "root")
			operation["x-required-scope"] = contract.access;
		const responses = operation.responses ? object(operation.responses) : {};
		for (const [status, responseValue] of Object.entries(responses)) {
			const entry = object(responseValue);
			if (
				((Number(status) < 200 || Number(status) >= 300) &&
					!(path === "/health" && status === "503")) ||
				["options", "head"].includes(method) ||
				path === "/metrics" ||
				!entry.content
			)
				continue;
			const content = object(entry.content);
			if (content["application/json"]) {
				const json = object(content["application/json"]);
				if (json.schema) json.schema = envelope(json.schema);
				content["application/json"] = json;
				entry.content = content;
				responses[status] = entry;
			}
		}
		for (const status of new Set(
			Object.values(errors).map(([status]) => status),
		)) {
			const existing = responses[status];
			const healthSchema =
				path === "/health" && status === 503 && existing
					? object(object(object(existing).content)["application/json"]).schema
					: undefined;
			responses[status] = {
				description:
					status === 429
						? "Rate limited; Retry-After identifies the retry delay"
						: "Request failed",
				content: {
					"application/json": {
						schema: healthSchema
							? {
									oneOf: [
										healthSchema,
										{ $ref: "#/components/schemas/ApiError" },
									],
								}
							: { $ref: "#/components/schemas/ApiError" },
					},
				},
				...(status === 401
					? {
							headers: {
								"WWW-Authenticate": {
									schema: { type: "string" },
									description: "Bearer authentication challenge",
								},
							},
						}
					: {}),
			};
		}
		const parameters = Array.isArray(operation.parameters)
			? operation.parameters.filter(
					(parameter) =>
						(!contract.query || object(parameter).in !== "query") &&
						!(
							object(parameter).in === "header" &&
							object(parameter).name === "Idempotency-Key"
						),
				)
			: [];
		if (
			contract.query === "resource" ||
			contract.query === "audits" ||
			contract.query === "deliveries"
		) {
			const fields: Record<string, unknown> = {
				limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
				cursor: { type: "string", maxLength: 1024 },
				sort: {
					type: "string",
					enum: [
						"createdAt",
						...(contract.query === "deliveries" ? [] : ["updatedAt"]),
						...(["/licenses", "/api-keys"].includes(path) ? ["expiresAt"] : []),
					],
					default: "createdAt",
				},
				direction: { type: "string", enum: ["asc", "desc"], default: "desc" },
				createdBefore: { type: "string", format: "date-time" },
				createdAfter: { type: "string", format: "date-time" },
			};
			if (contract.query === "resource")
				Object.assign(fields, {
					enabled: { type: "boolean" },
					...(path === "/webhooks"
						? {}
						: { search: { type: "string", minLength: 1, maxLength: 256 } }),
				});
			if (contract.query === "deliveries")
				Object.assign(fields, {
					webhookId: { type: "string", format: "uuid" },
					state: {
						type: "string",
						enum: ["pending", "claimed", "succeeded", "failed", "cancelled"],
					},
				});
			if (contract.query === "audits")
				fields.id = {
					type: "string",
					format: "uuid",
					description:
						"Filter audit history by ID; the response remains a collection.",
				};
			if (["/licenses", "/api-keys"].includes(path))
				Object.assign(fields, {
					hasExpiry: { type: "boolean" },
					expiresBefore: { type: "string", format: "date-time" },
					expiresAfter: { type: "string", format: "date-time" },
				});
			if (path === "/licenses")
				Object.assign(fields, {
					hasDeviceLimit: { type: "boolean" },
					userId: { type: "string", format: "uuid" },
					groupId: { type: "string", format: "uuid" },
				});
			for (const [name, schema] of Object.entries(fields))
				parameters.push({ in: "query", name, required: false, schema });
			operation.description = `${typeof operation.description === "string" ? operation.description : ""} Data is always a bounded array. Cursor requests preserve filters/sort/direction. Pages are not snapshots.${["/licenses", "/groups", "/users"].includes(path) ? " Exact top-level metadata filters use metadata.<name> for strings or metadataNumber.<name> for numbers." : ""}`;
		}
		if (contract.query === "events")
			parameters.push(
				{
					in: "query",
					name: "limit",
					required: false,
					schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
				},
				{
					in: "query",
					name: "cursor",
					required: false,
					schema: { type: "string", maxLength: 512 },
					description:
						"Principal/grant/epoch-bound replay cursor; an expired cursor requires snapshot resynchronization.",
				},
			);
		if (contract.idempotency)
			parameters.push({
				in: "header",
				name: "Idempotency-Key",
				required: contract.idempotency === "required",
				description:
					"Reuse only for retries of the same logical operation and identical input. Conflicting reuse is rejected; issuance/rotation never replay plaintext secrets.",
				schema: { type: "string", minLength: 1, maxLength: 256 },
			});
		operation.responses = responses;
		operation.parameters = parameters;
		route[method] = operation;
	}
	paths[path] = route;
}
specification.paths = paths;
function references(value: unknown) {
	if (!value || typeof value !== "object") return;
	if ("$ref" in value && typeof value.$ref === "string") {
		if (!value.$ref.startsWith("#/"))
			throw new Error("External schema reference");
		let target: unknown = specification;
		for (const part of value.$ref.slice(2).split("/"))
			target = object(target)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
		if (target === undefined)
			throw new Error(`Unresolved schema reference: ${value.$ref}`);
	}
	for (const child of Object.values(value)) references(child);
}
references(specification);
await Bun.write(
	"dist/server/openapi.json",
	`${JSON.stringify(specification, null, 2)}\n`,
);
console.log(
	`Generated ${Object.keys(paths).length} API paths without runtime services`,
);
