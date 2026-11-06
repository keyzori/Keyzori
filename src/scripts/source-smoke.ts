import assert from "node:assert/strict";
import { TestDatabase } from "../tests/fixtures/TestDatabase";
import { RuntimeContract } from "../tests/fixtures/RuntimeContract";
import { KeyGenerator } from "../core/security/KeyGenerator";
import { command } from "./command";
import { RuntimeWebhookFixture } from "../tests/fixtures/RuntimeWebhookFixture";
import { verifyRuntimeMaintenance } from "../tests/fixtures/RuntimeMaintenanceFixture";

const fixture = new TestDatabase();
const master = new KeyGenerator().master();
const cancellation = new AbortController();
const tls =
	process.platform === "linux"
		? new RuntimeWebhookFixture(cancellation.signal)
		: undefined;
const probe = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = probe.port;
await probe.stop(true);
const env = {
	...Bun.env,
	KZ_DATABASE_URL: fixture.url,
	KZ_MIGRATION_DATABASE_URL: fixture.url,
	KZ_REDIS_URL: Bun.env.KZ_TEST_REDIS_URL,
	KZ_MASTER_KEY: master,
	KZ_WEBHOOK_ENCRYPTION_KEY: new Bun.CryptoHasher("sha256")
		.update(Bun.randomUUIDv7())
		.digest("hex"),
	KZ_API_HOST: "127.0.0.1",
	KZ_API_PORT: String(port),
	KZ_LOG_LEVEL: "error",
};
let child: ReturnType<typeof Bun.spawn> | undefined;
const failures: unknown[] = [];
const interrupt = () => {
	cancellation.abort(new Error("Source smoke interrupted"));
	child?.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
	await tls?.prepare();
	if (tls) Object.assign(env, { NODE_EXTRA_CA_CERTS: tls.certificate });
	await fixture.start(false);
	await command([process.execPath, "--no-env-file", "src/main.ts", "migrate"], {
		env,
		signal: cancellation.signal,
	});
	cancellation.signal.throwIfAborted();
	child = Bun.spawn(
		[process.execPath, "--no-env-file", "src/main.ts", "serve"],
		{
			env: { ...env, KZ_MIGRATION_DATABASE_URL: undefined },
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	const origin = new URL(`http://127.0.0.1:${port}`);
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
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
		} catch {}
		if (child.exitCode !== null) break;
		await Bun.sleep(100);
	}
	assert.ok(ready, "Source service did not become ready");
	const contract = new RuntimeContract(origin, master);
	await contract.run();
	await verifyRuntimeMaintenance(contract, fixture.database);
	await tls?.run(contract);
	await tls?.prepareShutdown(contract);
	const stream = await contract.prepareShutdown();
	child.kill("SIGTERM");
	const kill = setTimeout(() => child?.kill("SIGKILL"), 30000);
	try {
		// On the pinned Windows runtime, subprocess.kill("SIGTERM") calls OS
		// termination without running the child's signal handler (exit 143).
		// Linux source/container checks retain the graceful-shutdown contract.
		assert.equal(
			await stream.closeCode(),
			process.platform === "win32" ? 1006 : 1012,
			process.platform === "win32"
				? "Forced Windows termination did not close the socket"
				: "Shutdown did not signal stream reconnection",
		);
		assert.equal(
			await child.exited,
			process.platform === "win32" ? 143 : 0,
			"Unexpected service termination",
		);
		await tls?.verifyShutdown(async (id) => {
			const [row] = await fixture.database
				.client`select id from webhook_deliveries where webhook_id=${id} and state='pending' and error='shutdown_outcome_unknown' and claim_token is null and lease_until is null`;
			return Boolean(row);
		});
	} finally {
		clearTimeout(kill);
		stream.close();
	}
	console.log(
		"Source smoke passed: explicit migration, consumption/replay/rotation, actual scheduled maintenance, secrecy and WebSocket authorization/reconnect",
	);
	console.log(
		process.platform === "win32"
			? "Windows subprocess termination passed; graceful signal shutdown is qualified by Linux source/container checks"
			: "Graceful source shutdown passed",
	);
	console.log(
		tls
			? "Real signed TLS, trust rejection, redirect refusal, cancellation and shutdown delivery passed"
			: "Real runtime TLS qualification is Linux-only; run the Linux CI smoke matrix for that coverage",
	);
} catch (error) {
	failures.push(error);
} finally {
	process.removeListener("SIGINT", interrupt);
	process.removeListener("SIGTERM", interrupt);
	if (child?.exitCode === null) {
		child.kill("SIGKILL");
		await child.exited;
	}
	const cleanup = await Promise.allSettled([fixture.stop(), tls?.close()]);
	for (const result of cleanup)
		if (result.status === "rejected") failures.push(result.reason);
}
if (failures.length)
	throw new AggregateError(failures, "Source smoke or cleanup failed");
