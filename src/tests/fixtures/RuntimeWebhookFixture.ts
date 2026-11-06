import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command } from "../../scripts/command";
import type { RuntimeContract } from "./RuntimeContract";

type Observation = {
	calls: {
		path: string;
		valid: boolean;
		deliveryId: string;
		eventId: string;
	}[];
	held: number;
	cancelled: number;
};

/** Linux qualification uses local TLS on an isolated public-address-shaped Docker subnet.
 * The production resolver, address policy, certificate validation and signer are untouched.
 */
export class RuntimeWebhookFixture {
	constructor(private readonly signal?: AbortSignal) {}
	readonly name = `keyzori-tls-${Bun.randomUUIDv7()}`;
	readonly address =
		`11.254.${1 + ((crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 250)}.2`;
	private readonly token = Bun.randomUUIDv7();
	private directory = "";
	private containerId: string | undefined;
	private networkId: string | undefined;
	private drainId: string | undefined;
	private cancellationsBeforeShutdown = 0;
	private get ownership() {
		const run = Bun.env.KZ_TEST_RUN_ID;
		assert.ok(
			run && /^[0-9a-f-]{36}$/.test(run),
			"TLS fixtures require their owning test-services invocation",
		);
		return ["--label", `dev.keyzori.test-run=${run}`];
	}
	get certificate() {
		return join(this.directory, "trusted.pem");
	}
	private async docker(
		args: string[],
		allowFailure = false,
		signal?: AbortSignal,
	) {
		return command(["docker", ...args], {
			env: { ...Bun.env, FIXTURE_CONTROL_TOKEN: this.token },
			timeoutMs: 60000,
			allowFailure,
			signal: signal ?? this.signal,
		});
	}
	async prepare() {
		assert.equal(
			process.platform,
			"linux",
			"Isolated runtime TLS qualification requires Linux Docker networking",
		);
		await Bun.write(resolve(".cache/.keep"), "");
		this.directory = await mkdtemp(resolve(".cache/runtime-tls-"));
		const openssl = Bun.which("openssl");
		assert.ok(
			openssl,
			"OpenSSL is required for disposable runtime TLS certificates",
		);
		for (const name of ["trusted", "untrusted"])
			await command(
				[
					openssl,
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-sha256",
					"-nodes",
					"-days",
					"1",
					"-keyout",
					join(this.directory, `${name}.key`),
					"-out",
					join(this.directory, `${name}.pem`),
					"-subj",
					"/CN=Keyzori disposable runtime receiver",
					"-addext",
					`subjectAltName=IP:${this.address}`,
					"-addext",
					"basicConstraints=critical,CA:TRUE",
				],
				{ signal: this.signal },
			);
		this.networkId = (
			await this.docker([
				"network",
				"create",
				"--internal",
				...this.ownership,
				"--label",
				`dev.keyzori.tls=${this.name}`,
				"--subnet",
				`${this.address.slice(0, this.address.lastIndexOf("."))}.0/24`,
				this.name,
			])
		).output;
		this.containerId = (
			await this.docker([
				"run",
				"-d",
				"--name",
				this.name,
				...this.ownership,
				"--label",
				`dev.keyzori.tls=${this.name}`,
				"--user",
				`${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`,
				"--network",
				this.name,
				"--ip",
				this.address,
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"-e",
				"FIXTURE_CONTROL_TOKEN",
				"--mount",
				`type=bind,source=${this.directory},target=/fixture,readonly`,
				"--mount",
				`type=bind,source=${resolve("src/tests/fixtures/runtime-webhook-receiver.ts")},target=/receiver.ts,readonly`,
				"--entrypoint",
				"bun",
				"oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4",
				"--no-env-file",
				"/receiver.ts",
			])
		).output;
		await this.until(async () => {
			try {
				await this.control();
				return true;
			} catch {
				return false;
			}
		}, "TLS receiver startup");
	}
	private async control(path = "/", body?: unknown): Promise<Observation> {
		const response = await fetch(`http://${this.address}:8080${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(2000),
		});
		assert.ok(response.ok, "TLS receiver control failed");
		const value: unknown = await response.json();
		assert.ok(value && typeof value === "object");
		assert.ok("calls" in value && Array.isArray(value.calls));
		assert.ok("held" in value && typeof value.held === "number");
		assert.ok("cancelled" in value && typeof value.cancelled === "number");
		const calls = value.calls.map((entry: unknown) => {
			assert.ok(entry && typeof entry === "object");
			assert.ok("path" in entry && typeof entry.path === "string");
			assert.ok("valid" in entry && typeof entry.valid === "boolean");
			assert.ok("deliveryId" in entry && typeof entry.deliveryId === "string");
			assert.ok("eventId" in entry && typeof entry.eventId === "string");
			return {
				path: entry.path,
				valid: entry.valid,
				deliveryId: entry.deliveryId,
				eventId: entry.eventId,
			};
		});
		return { calls, held: value.held, cancelled: value.cancelled };
	}
	private async until(
		predicate: () => Promise<boolean>,
		description: string,
		timeoutMs = 15000,
	) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			this.signal?.throwIfAborted();
			if (await predicate()) return;
			await Bun.sleep(50);
		}
		throw new Error(`${description} exceeded its deadline`);
	}
	private async endpoint(
		contract: RuntimeContract,
		path: string,
		trusted = true,
	) {
		const endpoint = await contract.data("/webhooks", "POST", {
			url: `https://${this.address}:${trusted ? 8443 : 8444}${path}`,
			events: ["license.created"],
			allGroups: true,
		});
		await this.control("/keys", {
			id: endpoint.signingKeyId,
			secret: endpoint.secret,
		});
		await contract.envelope("/webhooks/enable", "POST", { ids: [endpoint.id] });
		return String(endpoint.id);
	}
	private async deliveries(contract: RuntimeContract, webhookId: string) {
		const value = (
			await contract.envelope(`/webhooks/deliveries?webhookId=${webhookId}`)
		).data;
		assert.ok(Array.isArray(value));
		return value.map((entry: unknown) => {
			assert.ok(entry && typeof entry === "object");
			return Object.fromEntries(Object.entries(entry));
		});
	}
	async run(contract: RuntimeContract) {
		const trusted = await this.endpoint(contract, "/signed");
		const untrusted = await this.endpoint(contract, "/untrusted", false);
		const redirect = await this.endpoint(contract, "/redirect");
		await contract.data("/licenses", "POST", {});
		await this.until(
			async () =>
				(await this.deliveries(contract, trusted)).some(
					(delivery) => delivery.state === "succeeded",
				),
			"Signed TLS delivery",
		);
		await this.until(
			async () =>
				(await this.deliveries(contract, untrusted)).some(
					(delivery) =>
						Number(delivery.attempts) > 0 &&
						delivery.status === null &&
						delivery.error === "transport",
				),
			"Untrusted TLS rejection",
		);
		await this.until(
			async () =>
				(await this.deliveries(contract, redirect)).some(
					(delivery) => delivery.state === "failed" && delivery.status === 302,
				),
			"Redirect refusal",
		);
		const observed = await this.control();
		assert.ok(
			observed.calls.some((call) => call.path === "/signed" && call.valid),
		);
		assert.equal(
			observed.calls.some(
				(call) =>
					call.path === "/untrusted" ||
					call.path === "/unexpected-follow" ||
					!call.valid,
			),
			false,
		);
		await contract.envelope("/webhooks/disable", "POST", {
			ids: [trusted, untrusted, redirect],
		});
		const cancel = await this.endpoint(contract, "/cancel");
		await contract.data("/licenses", "POST", {});
		await this.until(
			async () =>
				(await this.control()).calls.some((call) => call.path === "/cancel"),
			"In-flight cancellable delivery",
		);
		await contract.envelope("/webhooks/disable", "POST", { ids: [cancel] });
		await this.until(
			async () =>
				(await this.deliveries(contract, cancel)).some(
					(delivery) => delivery.state === "cancelled",
				),
			"Delivery cancellation",
		);
		await this.until(
			async () => (await this.control()).cancelled > 0,
			"Cancellation closed the real TLS request",
		);
		await this.control("/release", {});
	}
	async prepareShutdown(contract: RuntimeContract) {
		this.cancellationsBeforeShutdown = (await this.control()).cancelled;
		this.drainId = await this.endpoint(contract, "/hold");
		await contract.data("/licenses", "POST", {});
		await this.until(
			async () =>
				(await this.control()).calls.some((call) => call.path === "/hold"),
			"Shutdown delivery barrier",
		);
	}
	async verifyShutdown(settled: (webhookId: string) => Promise<boolean>) {
		assert.ok(this.drainId);
		await this.until(
			async () =>
				(await this.control()).cancelled > this.cancellationsBeforeShutdown,
			"Shutdown cancelled its in-flight TLS request",
		);
		assert.ok(
			await settled(this.drainId),
			"Shutdown did not preserve its unknown-outcome signed delivery for retry",
		);
	}
	async close() {
		const failures: unknown[] = [];
		const signal = AbortSignal.timeout(20000);
		for (const kind of ["container", "network"] as const) {
			try {
				const listed = await this.docker(
					kind === "container"
						? [
								"ps",
								"-a",
								"--filter",
								`name=^/${this.name}$`,
								"--format",
								"{{.Names}}",
							]
						: [
								"network",
								"ls",
								"--filter",
								`name=^${this.name}$`,
								"--format",
								"{{.Name}}",
							],
					false,
					signal,
				);
				if (!listed.output) continue;
				assert.equal(listed.output, this.name);
				const inspected = await this.docker(
					[
						...(kind === "network" ? ["network"] : []),
						"inspect",
						"--format",
						kind === "container"
							? '{{.Id}} {{index .Config.Labels "dev.keyzori.tls"}}'
							: '{{.Id}} {{index .Labels "dev.keyzori.tls"}}',
						this.name,
					],
					false,
					signal,
				);
				const [id, owner] = inspected.output.split(" ");
				assert.ok(id && /^[a-f0-9]{64}$/.test(id));
				assert.equal(owner, this.name);
				const expected =
					kind === "container" ? this.containerId : this.networkId;
				if (expected) assert.equal(id, expected);
				await this.docker(
					kind === "container" ? ["rm", "-f", id] : ["network", "rm", id],
					false,
					signal,
				);
			} catch (error) {
				failures.push(error);
			}
		}
		if (this.directory)
			await rm(this.directory, { recursive: true, force: true }).catch(
				(error) => failures.push(error),
			);
		if (failures.length)
			throw new AggregateError(failures, "Runtime TLS fixture cleanup failed");
	}
}
