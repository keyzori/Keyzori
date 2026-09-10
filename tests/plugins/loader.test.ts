import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Elysia } from "elysia";
import { PluginLoader } from "../../src/plugins/PluginLoader.ts";
import { Application } from "../../src/application/Application.ts";
import { Config } from "../../src/shared/Config.ts";
import { root } from "../helpers/TestContext.ts";

const fixtureRoots: string[] = [];
const applications: Application[] = [];
async function fixture(name: string, expression: string) {
	const folder = await mkdtemp(join(tmpdir(), "keyzori-plugin-test-"));
	fixtureRoots.push(folder);
	await mkdir(join(folder, name));
	const source = `import { Elysia } from ${JSON.stringify(pathToFileURL(join(root, "node_modules/elysia/dist/index.mjs")).href)};\n${expression}`;
	await Bun.write(join(folder, name, "index.ts"), source);
	return folder;
}
function context() {
	const application = new Application(
		new Config({
			KEYZORI_ADMIN_KEY: "test-key-at-least-32-characters-long",
			KEYZORI_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
			KEYZORI_REDIS_URL: "redis://127.0.0.1:1",
		}),
		root,
	);
	applications.push(application);
	return application.context;
}
afterEach(async () => {
	for (const app of applications.splice(0)) await app.stop();
	for (const path of fixtureRoots.splice(0)) {
		if (!path.startsWith(join(tmpdir(), "keyzori-plugin-test-")))
			throw new Error("Unsafe fixture path");
		await rm(path, { recursive: true, force: true });
	}
});
describe("plugin discovery and contracts", () => {
	test("defaults to disabled and rejects missing enabled names", async () => {
		const loader = new PluginLoader(join(root, "plugins"));
		expect(await loader.discover()).toContain("stripe");
		expect(await loader.load([], context(), new Elysia())).toEqual([]);
		await expect(
			loader.load(["missing"], context(), new Elysia()),
		).rejects.toThrow("missing");
	});
	test("requires class, matching name, synchronous Elysia, and constructor prefix", async () => {
		for (const source of [
			"export default { name: 'demo', create() { return new Elysia(); } }",
			"export default class Demo { name = 'wrong'; create() { return new Elysia(); } }",
			"export default class Demo { name = 'demo'; create() { return new Elysia().get('/plugins/demo/a', () => 1); } }",
			"export default class Demo { name = 'demo'; async create() { return new Elysia({ prefix: '/plugins/demo' }); } }",
			"export default class Demo { name = 'demo'; create() { return new Elysia({ prefix: '/plugins/demo' }).use(Promise.resolve(new Elysia().get('/late', () => 1))); } }",
		]) {
			const folder = await fixture("demo", source);
			await expect(
				new PluginLoader(folder).load(["demo"], context(), new Elysia()),
			).rejects.toThrow();
		}
	});
	test("rejects exact and structurally duplicate routes before Elysia replaces them", async () => {
		for (const routes of [
			".get('/a', () => 1).get('/a', () => 2)",
			".get('/:id', () => 1).get('/:other', () => 2)",
			".all('/a', () => 1).get('/a', () => 2)",
		]) {
			const folder = await fixture(
				"demo",
				`export default class Demo { name = 'demo'; create() { return new Elysia({prefix: '/plugins/demo'})${routes}; } }`,
			);
			await expect(
				new PluginLoader(folder).load(["demo"], context(), new Elysia()),
			).rejects.toThrow("Duplicate route");
		}
		expect(
			new Elysia().get("/a", () => 1).get("/a", () => 2).routes,
		).toHaveLength(1);
	});
	test("requires shared guard on plugin admin routes", async () => {
		const folder = await fixture(
			"demo",
			"export default class Demo { name='demo'; create() { return new Elysia({prefix:'/plugins/demo'}).get('/admin/unsafe', () => 1); } }",
		);
		await expect(
			new PluginLoader(folder).load(["demo"], context(), new Elysia()),
		).rejects.toThrow("shared admin guard");
	});
	test("loads alphabetically and mounts unmodified prefixes with nested admin protection", async () => {
		const folder = await fixture(
			"zeta",
			"export default class Demo { name='zeta'; create() { return new Elysia({prefix:'/plugins/zeta'}).get('/ping', () => 'zeta'); } }",
		);
		await mkdir(join(folder, "alpha"));
		await Bun.write(
			join(folder, "alpha/index.ts"),
			`import { Elysia } from ${JSON.stringify(pathToFileURL(join(root, "node_modules/elysia/dist/index.mjs")).href)}; export default class Demo { name='alpha'; create(context) { return new Elysia({prefix:'/plugins/alpha'}).use(new Elysia({prefix:'/admin'}).use(context.adminGuard).get('/ping', () => 'alpha')); } }`,
		);
		const loader = new PluginLoader(folder);
		const app = new Elysia();
		const loaded = await loader.load(["zeta", "alpha"], context(), app);
		expect(loaded.map((p) => p.name)).toEqual(["alpha", "zeta"]);
		loader.mount(app, loaded);
		expect(app.routes.map((route) => route.path)).toEqual([
			"/plugins/alpha/admin/ping",
			"/plugins/zeta/ping",
		]);
	});
	test("enabled plugin validates its configuration before database startup", async () => {
		await expect(
			new PluginLoader(join(root, "plugins")).load(
				["stripe"],
				context(),
				new Elysia(),
			),
		).rejects.toThrow("KEYZORI_STRIPE_SECRET_KEY");
	});
});
