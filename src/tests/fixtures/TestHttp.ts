import { TestDatabase } from "./TestDatabase";
import { Config } from "../../core/config/Config";
import { ServerServices } from "../../core/ServerServices";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { createApp } from "../../app";

export class TestHttp {
	readonly fixture = new TestDatabase();
	readonly master = new KeyGenerator().master();
	readonly services;
	readonly app;
	constructor() {
		this.services = new ServerServices(
			new Config({
				KZ_DATABASE_URL: this.fixture.url,
				KZ_REDIS_URL: Bun.env.KZ_TEST_REDIS_URL,
				KZ_MASTER_KEY: this.master,
				KZ_API_HOST: "127.0.0.1",
				KZ_LOG_LEVEL: "error",
			}),
		);
		this.app = createApp(
			this.services,
			this.services.tracker,
			this.services.logger,
			this.services.metrics,
		);
	}
	async start() {
		await this.fixture.start();
		await this.services.redis.connect();
		this.services.health.ready = true;
		this.app.listen({ hostname: "127.0.0.1", port: 0 });
	}
	async stop() {
		await this.app.stop(true);
		this.services.redis.close();
		await this.services.database.close();
		await this.fixture.stop();
	}
	request(
		path: string,
		options: {
			method?: string;
			body?: unknown;
			credential?: string | null;
			headers?: Record<string, string>;
		} = {},
	) {
		const headers = new Headers(options.headers);
		if (options.credential !== null)
			headers.set(
				"Authorization",
				`Bearer ${options.credential ?? this.master}`,
			);
		if (options.body !== undefined)
			headers.set("Content-Type", "application/json");
		return fetch(new URL(path, this.app.server?.url), {
			method: options.method ?? "GET",
			headers,
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
		});
	}
}
