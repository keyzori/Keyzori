import type { $Action } from "../auth/scopes";

export type Access = "public" | "root" | $Action;
export type Operation = {
	method: "GET" | "POST" | "PATCH" | "DELETE" | "OPTIONS";
	path: string;
	access: Access;
	idempotency?: "required" | "optional";
	query?: "resource" | "events" | "audits" | "deliveries" | "none";
};

/** Every mounted operation must be explicitly admitted here. This is also reference metadata. */
export const operations: readonly Operation[] = [
	{ method: "GET", path: "/live", access: "public" },
	{ method: "GET", path: "/health", access: "public" },
	{ method: "GET", path: "/health/diagnostics", access: "root" },
	{ method: "POST", path: "/validate", access: "public" },
	{ method: "OPTIONS", path: "/validate", access: "public" },
	{ method: "GET", path: "/metrics", access: "root" },
	{ method: "GET", path: "/settings", access: "root" },
	{
		method: "PATCH",
		path: "/settings",
		access: "root",
		idempotency: "optional",
	},
	...(["licenses", "groups", "users", "api-keys", "webhooks"] as const).flatMap(
		(resource): Operation[] => {
			const action = (
				verb: "read" | "create" | "update" | "delete" | "enable" | "disable",
			): Exclude<Access, "public"> =>
				resource === "api-keys" ? "root" : `${resource}:${verb}`;
			return [
				{
					method: "GET",
					path: `/${resource}`,
					access: action("read"),
					query: "resource",
				},
				{
					method: "GET",
					path: `/${resource}/:id`,
					access: action("read"),
					query: "none",
				},
				{
					method: "POST",
					path: `/${resource}`,
					access: action("create"),
					idempotency: ["licenses", "api-keys", "webhooks"].includes(resource)
						? "required"
						: "optional",
				},
				{
					method: "PATCH",
					path: `/${resource}`,
					access: action("update"),
					idempotency: "optional",
				},
				{
					method: "DELETE",
					path: `/${resource}`,
					access: action("delete"),
					idempotency: "optional",
				},
				{
					method: "POST",
					path: `/${resource}/enable`,
					access: action("enable"),
					idempotency: "optional",
				},
				{
					method: "POST",
					path: `/${resource}/disable`,
					access: action("disable"),
					idempotency: "optional",
				},
			];
		},
	),
	{
		method: "POST",
		path: "/api-keys/rotate",
		access: "root",
		idempotency: "required",
	},
	{
		method: "POST",
		path: "/licenses/rotate",
		access: "licenses:rotate",
		idempotency: "required",
	},
	{
		method: "POST",
		path: "/licenses/consume",
		access: "usage:consume",
		idempotency: "required",
	},
	{
		method: "GET",
		path: "/usage/operations/:id",
		access: "usage:read",
		query: "none",
	},
	{
		method: "GET",
		path: "/usage/operations",
		access: "usage:read",
		idempotency: "required",
	},
	{
		method: "POST",
		path: "/licenses/meters/adjust",
		access: "usage:adjust",
		idempotency: "optional",
	},
	{
		method: "POST",
		path: "/licenses/hardware/register",
		access: "devices:register",
		idempotency: "optional",
	},
	{
		method: "POST",
		path: "/licenses/hardware/remove",
		access: "devices:remove",
		idempotency: "optional",
	},
	{
		method: "POST",
		path: "/licenses/ips/register",
		access: "ips:register",
		idempotency: "optional",
	},
	{
		method: "POST",
		path: "/licenses/ips/remove",
		access: "ips:remove",
		idempotency: "optional",
	},
	{
		method: "POST",
		path: "/groups/detach-licenses",
		access: "groups:delete",
		idempotency: "required",
	},
	{ method: "GET", path: "/events", access: "events:read", query: "events" },
	{
		method: "GET",
		path: "/events/stream",
		access: "events:subscribe",
		query: "none",
	},
	{
		method: "GET",
		path: "/events/watermark",
		access: "events:read",
		query: "none",
	},
	{ method: "GET", path: "/audits", access: "audits:read", query: "audits" },
	{
		method: "GET",
		path: "/webhooks/deliveries",
		access: "webhooks:read",
		query: "deliveries",
	},
	{
		method: "GET",
		path: "/webhooks/deliveries/:id",
		access: "webhooks:read",
		query: "none",
	},
	{
		method: "POST",
		path: "/webhooks/rotate-secret",
		access: "webhooks:rotate-secret",
		idempotency: "required",
	},
	{
		method: "POST",
		path: "/webhooks/activate-secret",
		access: "webhooks:rotate-secret",
		idempotency: "required",
	},
	{
		method: "POST",
		path: "/webhooks/replay",
		access: "webhooks:replay",
		idempotency: "required",
	},
	{
		method: "POST",
		path: "/webhooks/recover",
		access: "webhooks:recover",
		idempotency: "required",
	},
];

const exact = new Map(
	operations.map((operation) => [
		`${operation.method}:${operation.path}`,
		operation,
	]),
);
const parameterized = operations
	.filter((operation) => operation.path.includes(":"))
	.map((operation) => ({
		operation,
		path: new RegExp(`^${operation.path.replace(/:[^/]+/g, "[^/]+")}$`),
	}));

export function operationFor(method: string, path: string) {
	const verb = method === "HEAD" || method === "WS" ? "GET" : method;
	const normalized = path.length > 1 ? path.replace(/\/$/, "") : path;
	return (
		exact.get(`${verb}:${normalized}`) ??
		parameterized.find(
			(entry) => entry.operation.method === verb && entry.path.test(normalized),
		)?.operation
	);
}

/** Secondary authority checked transactionally by the resource services. */
export function operationAuthority(operation: Operation) {
	const { method, path, access } = operation;
	const required: $Action[] =
		access === "public" || access === "root" ? [] : [access];
	const conditional: { when: string; scope: $Action }[] = [];
	if (path.startsWith("/webhooks")) required.push("events:read");
	if (access === "groups:delete") required.push("licenses:disable");
	if (access === "users:delete") required.push("licenses:delete");
	if (path === "/licenses" && method === "PATCH")
		conditional.push({
			when: "changes.meters is present",
			scope: "usage:adjust",
		});
	if (path === "/licenses" && (method === "PATCH" || method === "POST"))
		conditional.push({
			when: `${method === "PATCH" ? "changes.userId" : "userId"} selects a user`,
			scope: "users:read",
		});
	return {
		required,
		conditional,
		allGroups:
			access === "groups:create" ||
			(access.startsWith("users:") && access !== "users:read"),
	};
}

export function assertOperations(
	routes: readonly { method: string; path: string }[],
) {
	for (const route of routes) {
		const method =
			route.method === "HEAD" || route.method === "WS" ? "GET" : route.method;
		if (!exact.has(`${method}:${route.path}`))
			throw new Error(
				`Undeclared HTTP operation: ${route.method} ${route.path}`,
			);
	}
}
