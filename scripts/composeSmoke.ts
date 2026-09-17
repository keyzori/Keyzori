import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Config } from "../src/shared/Config.ts";

/**
 * Exercises the repository Compose file with only its required secrets.
 *
 * Uses an existing server image to verify the configured defaults, failed-start
 * recovery, and volume persistence in an isolated Compose project.
 *
 * @param docker Runs Docker CLI arguments and returns standard output.
 * @param image Server image to use instead of building the Compose service.
 * @throws If a Docker or Compose operation or smoke assertion fails.
 */
export async function composeSmoke(
	docker: (...args: string[]) => Promise<string>,
	image: string,
) {
	const directory = await mkdtemp(join(tmpdir(), "keyzori-compose-smoke-"));
	const file = join(directory, "compose.json");
	const project = `keyzori-compose-${crypto.randomUUID().slice(0, 8)}`;
	const environment = {
		KEYZORI_DATABASE_URL:
			"postgresql://keyzori:compose-only@postgres:5432/keyzori",
		KEYZORI_REDIS_URL: "redis://redis:6379",
		KEYZORI_ADMIN_KEY: "compose-only-admin-key-at-least-32-characters",
		KEYZORI_PLUGINS: "stripe",
		KEYZORI_STRIPE_SECRET_KEY: "sk_test_fake",
		KEYZORI_STRIPE_WEBHOOK_SECRET: "whsec_smoke",
	};
	const source = join(directory, "compose.yml");
	const envFile = join(directory, ".env");
	await Bun.write(
		source,
		await Bun.file(resolve(import.meta.dir, "../compose.yml")).text(),
	);
	const secrets = `KEYZORI_ADMIN_KEY=${environment.KEYZORI_ADMIN_KEY}\nKEYZORI_POSTGRES_PASSWORD=compose-only\n`;
	await Bun.write(envFile, secrets);
	/**
	 * Renders the isolated Compose configuration using the current environment file.
	 *
	 * @returns The parsed Compose services configuration.
	 */
	async function render() {
		return JSON.parse(
			await docker(
				"compose",
				"--project-name",
				project,
				"--env-file",
				envFile,
				"--file",
				source,
				"config",
				"--format",
				"json",
			),
		) as { services: Record<string, Record<string, unknown>> };
	}
	const config = await render();
	const postgres = config.services.postgres;
	if (!postgres) throw new Error("Missing Compose PostgreSQL service");

	const server = config.services.server;
	if (!server || config.services.migrate)
		throw new Error("Expected server without a migration service");
	delete server.build;
	delete server.env_file;
	server.image = image;
	const defaults = server.environment as Record<string, string>;
	const settings = new Config(defaults);
	if (
		settings.sessionTtl !== 60 ||
		settings.rateLimit !== 120 ||
		settings.retentionDays !== 30 ||
		settings.plugins.length !== 0
	)
		throw new Error(
			"Server defaults must work with only the two Compose secrets.",
		);
	await Bun.write(
		envFile,
		`${secrets}KEYZORI_SESSION_TTL=90\nKEYZORI_RATE_LIMIT=240\nKEYZORI_ACTIVITY_RETENTION_DAYS=7\nKEYZORI_PLUGINS=stripe\nKEYZORI_TRUSTED_PROXIES=10.0.0.1\nKEYZORI_STRIPE_SECRET_KEY=sk_test_fake\n`,
	);
	const overridden = (await render()).services.server?.environment as Record<
		string,
		string
	>;
	const overrides = new Config(overridden);
	if (
		overrides.sessionTtl !== 90 ||
		overrides.rateLimit !== 240 ||
		overrides.retentionDays !== 7 ||
		overrides.plugins[0] !== "stripe" ||
		!overrides.trustedProxies.check("10.0.0.1", "ipv4") ||
		overridden.KEYZORI_STRIPE_SECRET_KEY !== "sk_test_fake"
	)
		throw new Error(
			"Optional settings must pass through the Compose env_file.",
		);
	await Bun.write(envFile, secrets);
	if (
		defaults.KEYZORI_PORT !== undefined ||
		defaults.KEYZORI_HOST !== undefined ||
		defaults.KEYZORI_REDIS_URL !== "redis://redis:6379"
	)
		throw new Error("Compose defaults were not supplied.");
	server.restart = "no";
	server.ports = ["127.0.0.1::6284"];
	const compose = (...args: string[]) =>
		docker("compose", "--project-name", project, "--file", file, ...args);
	async function ready() {
		const port = (await compose("port", "server", "6284")).split(":").at(-1);
		const url = `http://127.0.0.1:${port}`;
		for (let attempt = 0; attempt < 80; attempt++) {
			try {
				if (
					(await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1000) }))
						.ok
				)
					return url;
			} catch {
				/* startup */
			}
			await Bun.sleep(250);
		}
		throw new Error("Compose server did not become ready after migrations.");
	}
	try {
		await Bun.write(file, JSON.stringify(config));
		await compose("up", "--detach", "server");
		await ready();
		server.environment = { ...environment, KEYZORI_PLUGINS: "missing" };
		await Bun.write(file, JSON.stringify(config));
		await compose("up", "--detach", "server");
		const failed = await compose("ps", "--all", "--quiet", "server");
		if ((await docker("wait", failed)) !== "1")
			throw new Error("Failed startup must exit unsuccessfully.");
		server.environment = { ...environment };
		await Bun.write(file, JSON.stringify(config));
		await compose("up", "--detach", "server");
		const url = await ready();
		const headers = {
			"X-Admin-Key": environment.KEYZORI_ADMIN_KEY,
			"Content-Type": "application/json",
		};
		const created = await fetch(`${url}/admin/customers`, {
			method: "POST",
			headers,
			body: JSON.stringify({ email: "compose@example.com", name: "Compose" }),
		});
		if (created.status !== 201)
			throw new Error("Compose customer creation failed.");
		const customer = await created.json();
		// Recreate containers while retaining this isolated project's volumes.
		await compose("down");
		await compose("up", "--detach", "server");
		const restarted = await ready();
		const persisted = await fetch(
			`${restarted}/admin/customers/${customer.id}`,
			{ headers },
		);
		if (!persisted.ok || (await persisted.json()).id !== customer.id)
			throw new Error("Compose recreation lost persisted data.");
		console.log(
			"Compose smoke passed: startup failure/retry, readiness, and volume persistence.",
		);
	} finally {
		await compose("down", "--volumes", "--remove-orphans");
		await unlink(file);
		await unlink(source);
		await unlink(envFile);
		await rmdir(directory);
	}
}
