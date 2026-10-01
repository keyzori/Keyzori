import assert from "node:assert/strict";
import { version } from "../../version";

export class ArtifactContract {
	constructor(
		private readonly origin: URL,
		private readonly master: string,
	) {}
	private request(
		path: string,
		method = "GET",
		body?: unknown,
		credential: string | null = this.master,
		key?: string,
	) {
		const headers = new Headers();
		if (credential) headers.set("Authorization", `Bearer ${credential}`);
		if (body !== undefined) headers.set("Content-Type", "application/json");
		if (key) headers.set("Idempotency-Key", key);
		return fetch(new URL(path, this.origin), {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(16000),
		});
	}
	async run() {
		const health = await this.request("/health");
		assert.equal(health.status, 200);
		const status = await health.json();
		assert.equal(status.healthy, true);
		assert.equal(status.version, version);
		const userOperation = Bun.randomUUIDv7();
		const userInput = { name: "Artifact user" };
		const user = await (
			await this.request(
				"/users",
				"POST",
				userInput,
				this.master,
				userOperation,
			)
		).json();
		assert.equal(user.data.enabled, false);
		assert.deepEqual(
			await (
				await this.request(
					"/users",
					"POST",
					userInput,
					this.master,
					userOperation,
				)
			).json(),
			user,
		);
		assert.equal((await this.request("/openapi")).status, 404);
		assert.equal(
			(await this.request("/settings", "GET", undefined, null)).status,
			401,
		);
		assert.equal(
			(
				await this.request(
					"/validate",
					"POST",
					{ license: "unknown", injected: true },
					null,
				)
			).status,
			400,
		);
		const key = Bun.randomUUIDv7();
		const body = {
			deviceLimit: 2,
			meters: {
				upsert: [
					{ name: "requests", limit: 1 },
					{
						name: "calendar",
						limit: 10,
						schedule: {
							interval: "month",
							day: 31,
							time: "02:30",
							timezone: "Australia/Sydney",
						},
					},
				],
			},
		};
		const creation = await this.request(
			"/licenses",
			"POST",
			body,
			this.master,
			key,
		);
		assert.equal(creation.status, 200, await creation.clone().text());
		const issued = await creation.json();
		assert.equal(issued.data.enabled, false);
		assert.equal(typeof issued.credential, "string");
		assert.equal(
			(await this.request("/licenses", "POST", body, this.master, key)).status,
			409,
		);
		const disabled = await this.request(
			"/validate",
			"POST",
			{ license: issued.credential },
			null,
		);
		assert.equal(disabled.status, 200);
		assert.equal((await disabled.json()).code, "LICENSE_DISABLED");
		assert.equal(
			(
				await this.request("/licenses/enable", "POST", {
					ids: [issued.data.id],
				})
			).status,
			200,
		);
		const input = {
			license: issued.credential,
			hardwareId: "artifact",
			usage: { requests: 1 },
		};
		const usageKey = Bun.randomUUIDv7();
		const valid = await this.request(
			"/validate",
			"POST",
			input,
			null,
			usageKey,
		);
		assert.equal(valid.status, 200, await valid.clone().text());
		const result = await valid.json();
		assert.deepEqual(Object.keys(result).sort(), ["code", "reason"]);
		assert.equal(result.code, "VALID");
		assert.equal(
			(
				await (
					await this.request("/validate", "POST", input, null, usageKey)
				).json()
			).code,
			"VALID",
		);
		assert.equal(
			(
				await (
					await this.request(
						"/validate",
						"POST",
						input,
						null,
						Bun.randomUUIDv7(),
					)
				).json()
			).code,
			"USAGE_LIMIT_REACHED",
		);
		const own = await this.request(
			"/licenses/self",
			"GET",
			undefined,
			issued.credential,
		);
		assert.equal(own.status, 200);
		assert.equal(Object.hasOwn((await own.json()).data, "notes"), false);
		assert.equal(
			(await this.request("/metrics", "GET", undefined, issued.credential))
				.status,
			403,
		);
		const rotation = await this.request(
			"/licenses/rotate",
			"POST",
			{ ids: [issued.data.id] },
			this.master,
			Bun.randomUUIDv7(),
		);
		assert.equal(rotation.status, 200);
		assert.equal(
			(
				await (
					await this.request("/validate", "POST", input, null, usageKey)
				).json()
			).code,
			"LICENSE_INVALID",
		);
		const metrics = await this.request("/metrics");
		assert.equal(metrics.status, 200);
		assert.equal((await metrics.text()).includes(issued.credential), false);
	}
}
