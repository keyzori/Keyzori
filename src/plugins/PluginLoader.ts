import { readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Elysia, type AnyElysia } from "elysia";
import type { Plugin, PluginContext } from "./contract.ts";
import { canonicalRoute, createAudited } from "./routeAudit.ts";

export type LoadedPlugin = { name: string; directory: string; app: AnyElysia };
export class PluginLoader {
	constructor(private readonly directory: string) {}
	async discover() {
		if (!existsSync(this.directory)) return [];
		return (await readdir(this.directory, { withFileTypes: true }))
			.filter(
				(entry) =>
					entry.isDirectory() &&
					/^[a-z][a-z0-9-]{0,63}$/.test(entry.name) &&
					existsSync(join(this.directory, entry.name, "index.ts")),
			)
			.map((entry) => entry.name)
			.sort();
	}
	async load(enabled: string[], context: PluginContext, core: AnyElysia) {
		const available = await this.discover();
		if (new Set(enabled).size !== enabled.length)
			throw new Error("Duplicate enabled plugins.");
		const routes = core.routes.map((route) => ({
			method: route.method,
			path: route.path,
		}));
		const loaded: LoadedPlugin[] = [];
		for (const name of [...enabled].sort()) {
			if (!available.includes(name))
				throw new Error(`Enabled plugin ${name} is missing.`);
			const directory = join(this.directory, name);
			const entry = await realpath(join(directory, "index.ts"));
			if (!entry.startsWith((await realpath(directory)) + sep))
				throw new Error(`Plugin ${name} entry escapes its directory.`);
			const module = await import(pathToFileURL(entry).href);
			if (
				typeof module.default !== "function" ||
				!/^class\s/.test(Function.prototype.toString.call(module.default))
			)
				throw new Error(`Plugin ${name} must default-export a class.`);
			const candidate: unknown = new module.default();
			if (
				!candidate ||
				typeof candidate !== "object" ||
				!("name" in candidate) ||
				candidate.name !== name ||
				!("create" in candidate) ||
				typeof candidate.create !== "function"
			)
				throw new Error(`Invalid plugin contract: ${name}.`);
			if (candidate.create.constructor.name === "AsyncFunction")
				throw new Error(`Plugin ${name} create must be synchronous.`);
			const app = createAudited(candidate as Plugin, context);
			const prefix = `/plugins/${name}`;
			if (!(app instanceof Elysia) || app.config.prefix !== prefix)
				throw new Error(
					`Plugin ${name} must declare constructor prefix ${prefix}.`,
				);
			if (app.modules.size > 0)
				throw new Error(`Plugin ${name} must register routes synchronously.`);
			for (const route of app.routes) {
				if (!route.path.startsWith(`${prefix}/`) && route.path !== prefix)
					throw new Error(`Plugin ${name} has a route outside its prefix.`);
				const path = canonicalRoute(route.path);
				if (
					routes.some(
						(existing) =>
							canonicalRoute(existing.path) === path &&
							(existing.method === route.method ||
								existing.method === "ALL" ||
								route.method === "ALL"),
					)
				)
					throw new Error(`Duplicate route: ${route.method} ${route.path}.`);
				if (path === `${prefix}/admin` || path.startsWith(`${prefix}/admin/`)) {
					const before = route.hooks.beforeHandle;
					const hooks = Array.isArray(before) ? before : [before];
					if (
						!hooks.some((hook) =>
							context.adminGuard.event.beforeHandle?.some(
								(guard) => guard.fn === hook?.fn,
							),
						)
					)
						throw new Error(
							`Plugin ${name} admin route is missing the shared admin guard.`,
						);
				}
				routes.push({ method: route.method, path: route.path });
			}
			loaded.push({ name, directory, app });
		}
		return loaded;
	}
	mount(app: AnyElysia, plugins: LoadedPlugin[]) {
		for (const plugin of plugins) app.use(plugin.app);
	}
}
