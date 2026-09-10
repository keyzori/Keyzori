import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Application } from "../../src/application/Application.ts";
import { Config } from "../../src/shared/Config.ts";
import {
	integrationAvailable,
	root,
	TestContext,
} from "../helpers/TestContext.ts";

describe.skipIf(!integrationAvailable)("startup and lifecycle", () => {
	test("server refuses a fresh database; one-shot CLI migrates repeatedly without Redis", async () => {
		const ctx = new TestContext();
		await ctx.control.unsafe(`CREATE DATABASE "${ctx.name}"`);
		const sql = new SQL(ctx.env.KEYZORI_DATABASE_URL ?? "");
		try {
			await expect(ctx.app.start()).rejects.toThrow("Pending migrations");
			expect(ctx.app.app.server).toBeNull();
			expect(
				(await sql`SELECT to_regclass('public.licenses') AS name`)[0].name,
			).toBeNull();
			for (let attempt = 0; attempt < 2; attempt++) {
				const job = Bun.spawn([process.execPath, "src/main.ts", "migrate"], {
					cwd: root,
					env: { ...ctx.env, KEYZORI_REDIS_URL: "redis://127.0.0.1:1" },
					stdout: "pipe",
					stderr: "pipe",
				});
				const [code, output, error] = await Promise.all([
					job.exited,
					new Response(job.stdout).text(),
					new Response(job.stderr).text(),
				]);
				expect(error).toBe("");
				expect(code).toBe(0);
				expect(output).toContain("Migrations complete.");
			}
			await ctx.restart();
			expect((await ctx.request("/ready")).status).toBe(200);
		} finally {
			await sql.close();
			await ctx.close();
		}
	});
	test("enabling a plugin requires its separate one-shot migrations", async () => {
		const ctx = await new TestContext().start();
		try {
			await expect(
				ctx.restart({
					KEYZORI_PLUGINS: "stripe",
					KEYZORI_STRIPE_SECRET_KEY: "sk_test_fake",
					KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_test",
				}),
			).rejects.toThrow("Pending migrations in plugin_stripe");
			expect(ctx.app.app.server).toBeNull();
			await new Application(new Config(ctx.env), root).migrate();
			await ctx.restart();
			expect((await ctx.request("/plugins/stripe/admin/links")).status).toBe(
				200,
			);
		} finally {
			await ctx.close();
		}
	});
	test("concurrent one-shot jobs serialize migrations and leave disabled plugin tables absent", async () => {
		const ctx = new TestContext();
		await ctx.control.unsafe(`CREATE DATABASE "${ctx.name}"`);
		const second = new Application(new Config(ctx.env), root);
		try {
			await Promise.all([
				new Application(new Config(ctx.env), root).migrate(),
				new Application(new Config(ctx.env), root).migrate(),
			]);
			await Promise.all([ctx.app.start(), second.start()]);
			const rows = await ctx.app.services.database
				.sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'stripe%'`;
			expect(rows).toHaveLength(0);
			const journals = await ctx.app.services.database
				.sql`SELECT * FROM keyzori_migrations.core`;
			expect(journals).toHaveLength(1);
		} finally {
			await second.stop();
			await ctx.close();
		}
	});
	test("legacy databases are refused without modifying their rows", async () => {
		const ctx = new TestContext();
		await ctx.control.unsafe(`CREATE DATABASE "${ctx.name}"`);
		const sql = new SQL(ctx.env.KEYZORI_DATABASE_URL ?? "");
		try {
			await sql`CREATE TABLE legacy_license (value text)`;
			await sql`INSERT INTO legacy_license VALUES ('preserve-me')`;
			await expect(ctx.app.migrate()).rejects.toThrow("fresh database");
			expect(ctx.app.app.server).toBeNull();
			expect((await sql`SELECT * FROM legacy_license`)[0].value).toBe(
				"preserve-me",
			);
			expect(
				(await sql`SELECT to_regclass('public.licenses') AS name`)[0].name,
			).toBeNull();
		} finally {
			await sql.close();
			await ctx.close();
		}
	});
	test("modified migration history fails repeated startup", async () => {
		const ctx = await new TestContext().start();
		try {
			await ctx.app.services.database
				.sql`UPDATE keyzori_migrations.core SET hash = 'tampered'`;
			await expect(ctx.restart()).rejects.toThrow("modified migration");
			expect(ctx.app.app.server).toBeNull();
		} finally {
			await ctx.close();
		}
	});
	test("failed plugin migration rolls back its changes before opening HTTP", async () => {
		const folder = await fixture(
			"broken",
			"return new Elysia({prefix:'/plugins/broken'}).get('/ping', () => 'ok');",
		);
		const directory = join(
			folder,
			"plugins/broken/migrations/20260101000000_broken",
		);
		await mkdir(directory, { recursive: true });
		await Bun.write(
			join(directory, "migration.sql"),
			"CREATE TABLE should_rollback (id integer);\n--> statement-breakpoint\nSELECT * FROM table_that_does_not_exist;",
		);
		const ctx = new TestContext({ KEYZORI_PLUGINS: "broken" });
		await ctx.control.unsafe(`CREATE DATABASE "${ctx.name}"`);
		await ctx.app.stop();
		ctx.app = new Application(new Config(ctx.env), folder);
		const sql = new SQL(ctx.env.KEYZORI_DATABASE_URL ?? "");
		try {
			await expect(ctx.app.migrate()).rejects.toThrow();
			expect(ctx.app.app.server).toBeNull();
			expect(
				(await sql`SELECT to_regclass('public.should_rollback') AS name`)[0]
					.name,
			).toBeNull();
			expect(
				(await sql`SELECT to_regclass('public.licenses') AS name`)[0].name,
			).toBe("licenses");
		} finally {
			await sql.close();
			await ctx.close();
			await cleanup(folder);
		}
	});
	test("async lifecycle hooks finish before listen and database cleanup", async () => {
		const folder = await fixture(
			"lifecycle",
			"return new Elysia({prefix:'/plugins/lifecycle'}).onStart(async () => { await Bun.sleep(20); await Bun.write(new URL('./started', import.meta.url), 'yes'); }).onStop(async () => { await Bun.sleep(20); await context.database.ping(); await Bun.write(new URL('./stopped', import.meta.url), 'yes'); }).get('/ping', () => 'ok');",
		);
		const ctx = new TestContext({ KEYZORI_PLUGINS: "lifecycle" });
		await ctx.control.unsafe(`CREATE DATABASE "${ctx.name}"`);
		await ctx.app.stop();
		ctx.app = new Application(new Config(ctx.env), folder);
		try {
			await new Application(
				new Config({ ...ctx.env, KEYZORI_REDIS_URL: "redis://127.0.0.1:1" }),
				folder,
			).migrate();
			expect(
				await Bun.file(join(folder, "plugins/lifecycle/started")).exists(),
			).toBe(false);
			expect(
				await Bun.file(join(folder, "plugins/lifecycle/stopped")).exists(),
			).toBe(false);
			await ctx.app.start();
			expect(
				await Bun.file(join(folder, "plugins/lifecycle/started")).text(),
			).toBe("yes");
			await ctx.app.stop();
			expect(
				await Bun.file(join(folder, "plugins/lifecycle/stopped")).text(),
			).toBe("yes");
			await ctx.app.stop();
		} finally {
			await ctx.close();
			await cleanup(folder);
		}
	});
});

async function fixture(name: string, body: string) {
	const folder = await mkdtemp(join(tmpdir(), "keyzori-startup-test-"));
	await cp(join(root, "migrations"), join(folder, "migrations"), {
		recursive: true,
	});
	await mkdir(join(folder, "plugins", name), { recursive: true });
	await Bun.write(
		join(folder, "plugins", name, "index.ts"),
		`import { Elysia } from ${JSON.stringify(pathToFileURL(join(root, "node_modules/elysia/dist/index.mjs")).href)}; export default class TestPlugin { name = '${name}'; create(context) { ${body} } }`,
	);
	return folder;
}
async function cleanup(folder: string) {
	if (!folder.startsWith(join(tmpdir(), "keyzori-startup-test-")))
		throw new Error("Unsafe fixture directory");
	await rm(folder, { recursive: true, force: true });
}
