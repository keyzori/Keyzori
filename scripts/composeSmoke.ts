import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
	const config = Bun.YAML.parse(
		await Bun.file(resolve(import.meta.dir, "../compose.yml")).text(),
	) as {
		"x-application"?: unknown;
		services: Record<string, Record<string, unknown>>;
		networks?: unknown;
	};
	delete config["x-application"];
	const postgres = config.services.postgres;
	if (!postgres) throw new Error("Missing Compose PostgreSQL service");
	postgres.environment = {
		POSTGRES_USER: "keyzori",
		POSTGRES_DB: "keyzori",
		POSTGRES_PASSWORD: "compose-only",
	};
	const server = config.services.server;
	if (!server || config.services.migrate)
		throw new Error("Expected server without a migration service");
	delete server.build;
	delete server.env_file;
	server.image = image;
	server.environment = { ...environment };
	server.restart = "no";
	server.ports = ["127.0.0.1::3000"];
	const compose = (...args: string[]) =>
		docker("compose", "--project-name", project, "--file", file, ...args);
	async function ready() {
		const port = (await compose("port", "server", "3000")).split(":").at(-1);
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
		await rmdir(directory);
	}
}
