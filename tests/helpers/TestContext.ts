import { SQL } from "bun";
import { resolve } from "node:path";
import { Application } from "../../src/application/Application.ts";
import { Config, type Environment } from "../../src/shared/Config.ts";

export const integrationAvailable = Boolean(
	process.env.KEYZORI_TEST_DATABASE_URL && process.env.KEYZORI_TEST_REDIS_URL,
);
export const root = resolve(import.meta.dir, "../..");
export const adminKey = "test-only-admin-key-with-at-least-32-characters";
export class TestContext {
	readonly name = `keyzori_test_${crypto.randomUUID().replaceAll("-", "")}`;
	readonly env: Environment;
	readonly control: SQL;
	app: Application;
	constructor(overrides: Environment = {}) {
		const url = new URL(process.env.KEYZORI_TEST_DATABASE_URL ?? "");
		if (!["127.0.0.1", "localhost", "postgres"].includes(url.hostname))
			throw new Error("Integration tests require local PostgreSQL.");
		this.control = new SQL(url.href, { max: 1 });
		url.pathname = `/${this.name}`;
		this.env = {
			KEYZORI_DATABASE_URL: url.href,
			KEYZORI_REDIS_URL: process.env.KEYZORI_TEST_REDIS_URL,
			KEYZORI_ADMIN_KEY: adminKey,
			KEYZORI_PORT: "0",
			KEYZORI_PLUGINS: "",
			KEYZORI_RATE_LIMIT: "100000",
			...overrides,
		};
		this.app = new Application(new Config(this.env), root);
	}
	async start() {
		await this.control.unsafe(`CREATE DATABASE "${this.name}"`);
		await new Application(new Config(this.env), root).migrate();
		await this.app.start();
		return this;
	}
	get url() {
		return `http://127.0.0.1:${this.app.app.server?.port}`;
	}
	async restart(overrides: Environment = {}) {
		await this.app.stop();
		Object.assign(this.env, overrides);
		this.app = new Application(new Config(this.env), root);
		await this.app.start();
	}
	async close() {
		await this.app.stop();
		if (!/^keyzori_test_[a-f0-9]{32}$/.test(this.name))
			throw new Error("Unsafe test database name.");
		await this.control.unsafe(
			`DROP DATABASE IF EXISTS "${this.name}" WITH (FORCE)`,
		);
		await this.control.close();
	}
	async request(
		path: string,
		method = "GET",
		body?: unknown,
		headers: Record<string, string> = { "X-Admin-Key": adminKey },
	) {
		const response = await fetch(`${this.url}${path}`, {
			method,
			headers: { "content-type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	}
	async customer() {
		return this.app.services.customers.create({
			email: `${crypto.randomUUID()}@example.com`,
			name: "Test customer",
		});
	}
	async license(
		type: "lifetime" | "trial" | "subscription" | "metered" = "lifetime",
	) {
		const customer = await this.customer();
		const config =
			type === "trial"
				? ({ type, durationSeconds: 60 } as const)
				: type === "subscription"
					? ({
							type,
							expiresAt: new Date(Date.now() + 86400000).toISOString(),
						} as const)
					: { type };
		return this.app.services.licenses.create({
			customerId: customer.id,
			config,
		});
	}
	async activate(key: string, deviceId = "test-device", ip = "127.0.0.1") {
		return this.app.services.sessions.activate({ key, deviceId }, ip);
	}
}
