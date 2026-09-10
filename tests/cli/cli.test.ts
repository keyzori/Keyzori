import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test";
import {
	integrationAvailable,
	TestContext,
	root,
	adminKey,
} from "../helpers/TestContext.ts";
import { Cli } from "../../src/cli/Cli.ts";
import { StripeGateway } from "../../plugins/stripe/StripeGateway.ts";

describe.skipIf(!integrationAvailable)("CLI to API", () => {
	let ctx: TestContext;
	beforeAll(async () => {
		ctx = new TestContext({
			KEYZORI_PLUGINS: "stripe",
			KEYZORI_STRIPE_SECRET_KEY: "sk_test_fake",
			KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_fake",
		});
		await ctx.start();
	});
	afterAll(async () => {
		await ctx?.close();
	});
	async function run(args: string[]) {
		const results: unknown[] = [];
		await new Cli(
			{
				KEYZORI_URL: ctx.url,
				KEYZORI_ADMIN_KEY: adminKey,
				KEYZORI_PLUGINS: "stripe",
			},
			root,
			(value) => results.push(value),
		).run(args);
		return JSON.parse(JSON.stringify(results[0]));
	}
	test("class commands administer each core feature through the HTTP client", async () => {
		const customer = await run([
			"customers",
			"create",
			JSON.stringify({ email: "cli@example.com", name: "CLI" }),
		]);
		expect((await run(["customers", "get", customer.id])).id).toBe(customer.id);
		const license = await run([
			"licenses",
			"create",
			JSON.stringify({ customerId: customer.id, config: { type: "metered" } }),
		]);
		await run([
			"access",
			"policy",
			license.id,
			JSON.stringify({ maxSessions: 2 }),
		]);
		expect((await run(["access", "get", license.id])).license.maxSessions).toBe(
			2,
		);
		const meter = await run([
			"meters",
			"create",
			JSON.stringify({ licenseId: license.id, name: "exports", limit: 5 }),
		]);
		expect(
			(await run(["meters", "update", meter.id, JSON.stringify({ limit: 6 })]))
				.limit,
		).toBe(6);
		const session = await ctx.activate(license.key);
		expect((await run(["sessions", "list", license.id])).items).toHaveLength(1);
		await run(["sessions", "terminate", license.id]);
		await expect(
			ctx.app.services.sessions.heartbeat({
				token: session.token,
				deviceId: "test-device",
				ip: "127.0.0.1",
			}),
		).rejects.toBeDefined();
		expect(
			(await run(["activity", "list", "--licenseId", license.id])).items.length,
		).toBeGreaterThan(0);
		expect((await run(["usage", license.id])).items).toHaveLength(0);
		await run(["licenses", "revoke", license.id]);
		await run(["licenses", "restore", license.id]);
		expect((await run(["licenses", "rotate", license.id])).key).not.toBe(
			license.key,
		);
	});
	test("plugin commands link, sync, inspect, and unlink billing through the API", async () => {
		const gateway = spyOn(
			StripeGateway.prototype,
			"subscription",
		).mockResolvedValue({
			subscriptionId: "sub_cli",
			customerId: "cus_cli",
			status: "active",
			expiresAt: new Date(Date.now() + 86400000),
		});
		try {
			const license = await ctx.license("subscription");
			expect(
				(await run(["stripe", "link", license.id, "sub_cli"])).subscriptionId,
			).toBe("sub_cli");
			expect((await run(["stripe", "sync", license.id])).status).toBe("active");
			expect((await run(["stripe", "links"])).items).toHaveLength(1);
			expect((await run(["stripe", "events"])).items).toHaveLength(0);
			await run(["stripe", "unlink", license.id]);
		} finally {
			gateway.mockRestore();
		}
	});
	test("CLI subprocess requires only HTTP configuration and reports failure exit codes", async () => {
		const child = Bun.spawn(
			[process.execPath, "src/main.ts", "admin", "customers", "list"],
			{
				cwd: root,
				env: {
					...process.env,
					KEYZORI_URL: ctx.url,
					KEYZORI_ADMIN_KEY: adminKey,
					KEYZORI_PLUGINS: "",
					KEYZORI_DATABASE_URL: "unused",
					KEYZORI_REDIS_URL: "unused",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(await child.exited).toBe(0);
		expect(
			JSON.parse(await new Response(child.stdout).text()).items.length,
		).toBeGreaterThan(0);
		const invalid = Bun.spawn(
			[process.execPath, "src/main.ts", "admin", "customers", "list"],
			{
				cwd: root,
				env: {
					...process.env,
					KEYZORI_URL: ctx.url,
					KEYZORI_ADMIN_KEY: "wrong-key-with-at-least-32-characters",
					KEYZORI_PLUGINS: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(await invalid.exited).toBe(1);
		expect(await new Response(invalid.stderr).text()).toContain("UNAUTHORIZED");
	});
});
