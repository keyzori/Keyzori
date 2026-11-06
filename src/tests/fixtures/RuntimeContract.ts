import assert from "node:assert/strict";
import { RuntimeSocket } from "./RuntimeSocket";

function record(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return Object.fromEntries(Object.entries(value));
}
function text(value: unknown) {
	assert.equal(typeof value, "string");
	return String(value);
}
function entries(value: unknown) {
	assert.ok(Array.isArray(value));
	return value.map(record);
}

/** Critical HTTP/WebSocket contract shared by source and exact-image smoke checks. */
export class RuntimeContract {
	constructor(
		private readonly origin: URL,
		private readonly master: string,
	) {}
	async request(
		path: string,
		method = "GET",
		body?: unknown,
		authenticated: boolean | string = true,
		idempotencyKey = Bun.randomUUIDv7(),
	) {
		return fetch(new URL(path, this.origin), {
			method,
			headers: {
				...(authenticated
					? {
							Authorization: `Bearer ${authenticated === true ? this.master : authenticated}`,
						}
					: {}),
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				"Idempotency-Key": idempotencyKey,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(16000),
		});
	}
	async envelope(
		path: string,
		method = "GET",
		body?: unknown,
		authenticated: boolean | string = true,
		idempotencyKey?: string,
	) {
		const response = await this.request(
			path,
			method,
			body,
			authenticated,
			idempotencyKey,
		);
		const value = record(await response.json());
		assert.ok(
			response.ok,
			`${method} ${path}: HTTP ${response.status}; ${JSON.stringify(value.error)}`,
		);
		assert.equal(value.ok, true);
		assert.equal(value.error, null);
		assert.equal(typeof record(value.meta).requestId, "string");
		return value;
	}
	async data(
		path: string,
		method = "GET",
		body?: unknown,
		authenticated: boolean | string = true,
		idempotencyKey?: string,
	) {
		return record(
			(await this.envelope(path, method, body, authenticated, idempotencyKey))
				.data,
		);
	}
	async run() {
		assert.equal(
			(await this.data("/health", "GET", undefined, false)).healthy,
			true,
		);
		const denied = await this.request("/settings", "GET", undefined, false);
		assert.equal(denied.status, 401);
		assert.match(denied.headers.get("WWW-Authenticate") ?? "", /Bearer/i);
		assert.equal(record(await denied.json()).ok, false);
		const key = await this.data("/api-keys", "POST", {
			name: "Smoke integration",
		});
		assert.deepEqual(key.scopes, []);
		assert.equal(key.allGroups, false);
		const credential = text(key.credential);
		const group = await this.data("/groups", "POST", {
			name: "Smoke group",
			notes: "private-group-note",
		});
		const user = await this.data("/users", "POST", {
			name: "Smoke user",
			notes: "private-user-note",
		});
		await this.envelope("/groups/enable", "POST", { ids: [group.id] });
		await this.envelope("/users/enable", "POST", { ids: [user.id] });
		await this.envelope("/api-keys", "PATCH", {
			ids: [key.id],
			changes: {
				scopes: [
					"licenses:read",
					"usage:read",
					"usage:consume",
					"devices:read",
					"ips:read",
					"events:read",
					"events:subscribe",
				],
				allGroups: false,
				groupIds: [group.id],
			},
		});
		await this.envelope("/api-keys/enable", "POST", { ids: [key.id] });
		const issuedKey = Bun.randomUUIDv7();
		const creation = {
			groupId: group.id,
			userId: user.id,
			notes: "private-license-note",
			metadata: { purpose: "smoke" },
			meters: { upsert: [{ name: "requests", limit: "2" }] },
		};
		const license = await this.data(
			"/licenses",
			"POST",
			creation,
			true,
			issuedKey,
		);
		const original = text(license.credential);
		const repeatedIssue = await this.request(
			"/licenses",
			"POST",
			creation,
			true,
			issuedKey,
		);
		assert.equal(repeatedIssue.status, 409);
		assert.equal((await repeatedIssue.text()).includes(original), false);
		assert.equal(
			(await this.data("/validate", "POST", { license: original }, false))
				.valid,
			false,
		);
		await this.envelope("/licenses/enable", "POST", { ids: [license.id] });
		await this.envelope("/licenses/hardware/register", "POST", {
			licenseId: license.id,
			hardwareId: "smoke-device",
		});
		await this.envelope("/licenses/ips/register", "POST", {
			licenseId: license.id,
			ip: "203.0.113.7",
		});
		const valid = await this.data(
			"/validate",
			"POST",
			{ license: original, expectedGroupId: group.id },
			false,
		);
		assert.equal(valid.valid, true);
		const view = record(valid.license);
		assert.deepEqual(view.hardwareIds, ["smoke-device"]);
		assert.deepEqual(view.registeredIps, ["203.0.113.7"]);
		for (const projected of [view, record(view.group), record(view.user)])
			assert.equal("notes" in projected, false);
		assert.equal(entries(view.meters)[0]?.value, "0");
		assert.equal(
			(
				await this.data(
					"/validate",
					"POST",
					{ license: original, expectedGroupId: null },
					false,
				)
			).valid,
			false,
		);
		const usageKey = Bun.randomUUIDv7();
		const usage = { licenseId: license.id, usage: { requests: "2" } };
		assert.equal(
			(await this.request("/licenses/consume", "POST", usage, original)).status,
			401,
			"A licence credential must not authorize consumption",
		);
		const operatorProbe = await this.data("/licenses", "POST", {
			meters: { upsert: [{ name: "operator", limit: "1" }] },
		});
		await this.envelope("/licenses/enable", "POST", {
			ids: [operatorProbe.id],
		});
		const operatorUse = await this.data("/licenses/consume", "POST", {
			licenseId: operatorProbe.id,
			usage: { operator: "1" },
		});
		assert.equal(
			entries(operatorUse.entries)[0]?.after,
			"1",
			"The environment master must retain unrestricted access",
		);
		await this.envelope("/licenses", "DELETE", {
			ids: [operatorProbe.id],
			confirm: true,
			reason: "Runtime fixture cleanup",
		});
		const accepted = await this.data(
			"/licenses/consume",
			"POST",
			usage,
			credential,
			usageKey,
		);
		const replay = await this.data(
			"/licenses/consume",
			"POST",
			usage,
			credential,
			usageKey,
		);
		assert.equal(accepted.id, replay.id);
		assert.equal(replay.replayed, true);
		assert.equal(
			(
				await this.data(
					`/usage/operations?licenseId=${license.id}`,
					"GET",
					undefined,
					credential,
					usageKey,
				)
			).id,
			accepted.id,
			"Lost-response lookup did not recover the accepted operation",
		);
		assert.equal(entries(accepted.entries)[0]?.after, "2");
		assert.equal(
			(
				await this.request(
					"/licenses/consume",
					"POST",
					{ licenseId: license.id, usage: { requests: "1" } },
					credential,
					usageKey,
				)
			).status,
			409,
		);
		assert.equal(
			(await this.request("/licenses/consume", "POST", usage, credential))
				.status,
			409,
		);
		assert.equal(
			(await this.data("/validate", "POST", { license: original }, false))
				.valid,
			true,
			"Exhaustion must not invalidate a licence",
		);
		const rotated = entries(
			(await this.envelope("/licenses/rotate", "POST", { ids: [license.id] }))
				.data,
		)[0];
		assert.ok(rotated);
		const replacement = text(rotated.credential);
		assert.equal(
			(await this.data("/validate", "POST", { license: original }, false))
				.license,
			null,
		);
		assert.equal(
			(await this.data("/validate", "POST", { license: replacement }, false))
				.valid,
			true,
		);
		assert.equal(
			(
				await this.data(
					"/licenses/consume",
					"POST",
					usage,
					credential,
					usageKey,
				)
			).id,
			accepted.id,
		);
		assert.equal(
			(await this.request("/metrics", "GET", undefined, credential)).status,
			403,
			"An API key gained master-only metrics access",
		);
		await this.stream(credential, text(key.id), text(license.id));
		for (const path of ["/api-keys", "/licenses", "/audits", "/metrics"]) {
			const response = await this.request(path);
			assert.ok(response.ok);
			const body = await response.text();
			for (const secret of [this.master, credential, original, replacement])
				assert.equal(
					body.includes(secret),
					false,
					`${path} exposed a credential`,
				);
		}
		assert.ok(Array.isArray((await this.envelope("/licenses")).data));
		assert.equal((await this.data(`/licenses/${license.id}`)).id, license.id);
		assert.equal(
			(await this.request(`/licenses?id=${license.id}`)).status,
			400,
		);
		assert.equal(
			(await this.request("/metrics", "GET", undefined, false)).status,
			401,
		);
		const removal = { ids: [group.id], confirm: true, reason: "Smoke cleanup" };
		const deletionKey = Bun.randomUUIDv7();
		await this.envelope("/groups", "DELETE", removal, true, deletionKey);
		await this.envelope("/groups", "DELETE", removal, true, deletionKey);
		assert.equal(
			(await this.data(`/usage/operations/${accepted.id}`)).historical,
			true,
		);
		assert.equal(
			(await this.data("/validate", "POST", { license: replacement }, false))
				.valid,
			false,
		);
		return text(license.id);
	}
	private async stream(credential: string, keyId: string, licenseId: string) {
		const first = new RuntimeSocket(this.origin, credential);
		let cursor = "";
		try {
			await first.subscribe();
			const deadline = Date.now() + 10000;
			let found = false;
			while (Date.now() < deadline && !found) {
				const frame = await first.next();
				assert.equal(frame.type, "events");
				cursor = text(frame.cursor);
				found = entries(frame.data).some(
					(event) => event.event === "usage.consumed",
				);
			}
			assert.ok(found, "Published consumption was not replayed over WebSocket");
		} finally {
			first.close();
		}
		await this.envelope("/licenses/disable", "POST", {
			ids: [licenseId],
			reason: "Stream replay marker",
		});
		const reconnected = new RuntimeSocket(this.origin, credential);
		try {
			await reconnected.subscribe(cursor);
			let found = false;
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline && !found) {
				const frame = await reconnected.next();
				assert.equal(frame.type, "events");
				found = entries(frame.data).some(
					(event) => event.event === "license.disabled",
				);
			}
			assert.ok(found, "Reconnect lost the replay/live boundary event");
			await this.envelope("/api-keys/disable", "POST", { ids: [keyId] });
			assert.equal(
				await reconnected.closeCode(),
				1008,
				"Revoked stream retained delivery authority",
			);
		} finally {
			reconnected.close();
		}
		assert.equal(
			(await this.request("/events", "GET", undefined, credential)).status,
			401,
		);
		const rejected = new RuntimeSocket(this.origin, credential);
		try {
			await assert.rejects(rejected.next(3000), /Stream (handshake|closed)/);
		} finally {
			rejected.close();
		}
	}
	async prepareShutdown() {
		const socket = new RuntimeSocket(this.origin, this.master);
		await socket.subscribe();
		await socket.next();
		return socket;
	}
}
