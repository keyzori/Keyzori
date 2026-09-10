import { Elysia, type AnyElysia } from "elysia";
import type { Plugin, PluginContext } from "./contract.ts";

export function canonicalRoute(path: string) {
	return path.replace(/:[^/]+/g, ":param").replace(/\/+$/, "");
}

// The pinned Elysia release silently replaces identical registrations. Observe
// its registration boundary during synchronous create() so duplicates cannot
// disappear before inspection. Restore it before any asynchronous work or I/O.
export function createAudited(plugin: Plugin, context: PluginContext) {
	const descriptor = Object.getOwnPropertyDescriptor(Elysia.prototype, "add");
	if (!descriptor || typeof descriptor.value !== "function")
		throw new Error("Unsupported Elysia route registration API.");
	const original = descriptor.value as (
		this: AnyElysia,
		...args: unknown[]
	) => unknown;
	const seen = new WeakMap<AnyElysia, { method: string; path: string }[]>();
	Object.defineProperty(Elysia.prototype, "add", {
		...descriptor,
		value: function (this: AnyElysia, ...args: unknown[]) {
			const [method, route, , , options] = args;
			if (typeof method !== "string" || typeof route !== "string")
				throw new Error("Unsupported plugin route registration.");
			const skipPrefix =
				options &&
				typeof options === "object" &&
				"skipPrefix" in options &&
				options.skipPrefix;
			const path = canonicalRoute(
				`${skipPrefix ? "" : (this.config.prefix ?? "")}${route && !route.startsWith("/") ? "/" : ""}${route}`,
			);
			const routes = seen.get(this) ?? [];
			if (
				routes.some(
					(prior) =>
						prior.path === path &&
						(prior.method === method ||
							prior.method === "ALL" ||
							method === "ALL"),
				)
			)
				throw new Error(`Duplicate route: ${method} ${path}.`);
			routes.push({ method, path });
			seen.set(this, routes);
			return original.apply(this, args);
		},
	});
	try {
		return plugin.create(context);
	} finally {
		Object.defineProperty(Elysia.prototype, "add", descriptor);
	}
}
