import assert from "node:assert/strict";
import { TestDatabase } from "../tests/fixtures/TestDatabase";
import { RuntimeContract } from "../tests/fixtures/RuntimeContract";
import { KeyGenerator } from "../core/security/KeyGenerator";
import { command } from "./command";
import { RuntimeWebhookFixture } from "../tests/fixtures/RuntimeWebhookFixture";
import { verifyRuntimeMaintenance } from "../tests/fixtures/RuntimeMaintenanceFixture";

const fixture = new TestDatabase();
const name = `keyzori-smoke-${Bun.randomUUIDv7()}`;
const migrator = `keyzori-smoke-${Bun.randomUUIDv7()}`;
const master = new KeyGenerator().master();
const cancellation = new AbortController();
let phaseSignal = cancellation.signal;
const tls =
	process.platform === "linux"
		? new RuntimeWebhookFixture(cancellation.signal)
		: undefined;
const databaseUrl = new URL(fixture.url);
const redisUrl = new URL(Bun.env.KZ_TEST_REDIS_URL ?? "");
databaseUrl.hostname =
	process.platform === "linux" ? "127.0.0.1" : "host.docker.internal";
redisUrl.hostname = databaseUrl.hostname;
const probe = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = probe.port;
await probe.stop(true);
const env = {
	...Bun.env,
	KZ_DATABASE_URL: databaseUrl.href,
	KZ_MIGRATION_DATABASE_URL: databaseUrl.href,
	KZ_REDIS_URL: redisUrl.href,
	KZ_MASTER_KEY: master,
	KZ_WEBHOOK_ENCRYPTION_KEY: new Bun.CryptoHasher("sha256")
		.update(Bun.randomUUIDv7())
		.digest("hex"),
	NODE_EXTRA_CA_CERTS: tls ? "/runtime-trust.pem" : undefined,
	KZ_API_HOST: "0.0.0.0",
	KZ_API_PORT: process.platform === "linux" ? String(port) : "6284",
	KZ_LOG_LEVEL: "error",
};
const network =
	process.platform === "linux"
		? ["--network", "host"]
		: ["--add-host", "host.docker.internal:host-gateway"];
const environments = [
	"KZ_DATABASE_URL",
	"KZ_REDIS_URL",
	"KZ_MASTER_KEY",
	"KZ_WEBHOOK_ENCRYPTION_KEY",
	"NODE_EXTRA_CA_CERTS",
	"KZ_API_HOST",
	"KZ_API_PORT",
	"KZ_LOG_LEVEL",
].flatMap((key) => ["-e", key]);
const docker = (args: string[], allowFailure = false) =>
	command(["docker", ...args], {
		env,
		allowFailure,
		timeoutMs: 60000,
		signal: phaseSignal,
	});
const failures: unknown[] = [];
const interrupt = () =>
	cancellation.abort(new Error("Container smoke interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
	await tls?.prepare();
	await fixture.start(false);
	await docker([
		"run",
		"--rm",
		"--name",
		migrator,
		"--label",
		`dev.keyzori.test-run=${Bun.env.KZ_TEST_RUN_ID ?? ""}`,
		...network,
		...environments,
		"-e",
		"KZ_MIGRATION_DATABASE_URL",
		...(tls
			? [
					"--mount",
					`type=bind,source=${tls.certificate},target=/runtime-trust.pem,readonly`,
				]
			: []),
		"keyzori-server:test",
		"migrate",
	]);
	await docker([
		"run",
		"-d",
		"--name",
		name,
		"--label",
		`dev.keyzori.smoke=${name}`,
		"--label",
		`dev.keyzori.test-run=${Bun.env.KZ_TEST_RUN_ID ?? ""}`,
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		...network,
		...(process.platform === "linux" ? [] : ["-p", "127.0.0.1::6284"]),
		...environments,
		...(tls
			? [
					"--mount",
					`type=bind,source=${tls.certificate},target=/runtime-trust.pem,readonly`,
				]
			: []),
		"keyzori-server:test",
	]);
	const boundPort =
		process.platform === "linux"
			? port
			: (await docker(["port", name, "6284/tcp"])).output.split(":").at(-1);
	const origin = new URL(`http://127.0.0.1:${boundPort}`);
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		try {
			if (
				(
					await fetch(new URL("/health", origin), {
						signal: AbortSignal.timeout(300),
					})
				).ok
			) {
				ready = true;
				break;
			}
		} catch {
			// A refused connection is expected until startup completes; the loop is bounded.
		}
		await Bun.sleep(100);
	}
	assert.ok(ready, "Container did not become ready");
	assert.equal(
		(await docker(["inspect", "--format", "{{.Config.User}}", name])).output,
		"65532:65532",
	);
	assert.equal(
		(await docker(["exec", name, "keyzori-bun", "--revision"])).output,
		(await Bun.file(".bun-revision").text()).trim(),
		"Image runtime does not match the reviewed Bun revision",
	);
	const contract = new RuntimeContract(origin, master);
	await contract.run();
	await verifyRuntimeMaintenance(contract, fixture.database);
	await tls?.run(contract);
	await tls?.prepareShutdown(contract);
	const stream = await contract.prepareShutdown();
	try {
		await docker(["kill", "--signal", "TERM", name]);
		assert.equal(
			await stream.closeCode(),
			1012,
			"Shutdown did not signal stream reconnection",
		);
		await docker(["wait", name]);
		await tls?.verifyShutdown(async (id) => {
			const [row] = await fixture.database
				.client`select id from webhook_deliveries where webhook_id=${id} and state='pending' and error='shutdown_outcome_unknown' and claim_token is null and lease_until is null`;
			return Boolean(row);
		});
	} finally {
		stream.close();
	}
	assert.equal(
		(await docker(["inspect", "--format", "{{.State.ExitCode}}", name])).output,
		"0",
	);
	console.log(
		"Container smoke passed: migration, non-root read-only source runtime, consumption/replay/rotation, actual scheduled maintenance, secrecy, WebSocket authorization and shutdown",
	);
	console.log(
		tls
			? "Exact-image signed TLS, trust rejection, redirect refusal, cancellation and shutdown delivery passed"
			: "Real runtime TLS qualification is Linux-only; run the Linux CI smoke matrix for that coverage",
	);
} catch (error) {
	failures.push(error);
} finally {
	process.removeListener("SIGINT", interrupt);
	process.removeListener("SIGTERM", interrupt);
	phaseSignal = AbortSignal.timeout(20000);
	try {
		const exists = await docker([
			"ps",
			"-a",
			"--filter",
			`name=^/${name}$`,
			"--format",
			"{{.Names}}",
		]);
		if (exists.output === name) {
			const inspected = (
				await docker([
					"inspect",
					"--format",
					'{{.Id}} {{index .Config.Labels "dev.keyzori.smoke"}}',
					name,
				])
			).output;
			const [id, owner] = inspected.split(" ");
			assert.equal(owner, name, "Refusing to remove a foreign smoke container");
			assert.ok(id && /^[a-f0-9]{64}$/.test(id));
			await docker(["rm", "-f", id]);
		}
	} catch (error) {
		failures.push(error);
	} finally {
		const cleanup = await Promise.allSettled([fixture.stop(), tls?.close()]);
		for (const result of cleanup)
			if (result.status === "rejected") failures.push(result.reason);
	}
}
if (failures.length)
	throw new AggregateError(failures, "Container smoke or cleanup failed");
