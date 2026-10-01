import { resolve, relative } from "node:path";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestDatabase } from "../tests/fixtures/TestDatabase";
import { ArtifactContract } from "../tests/fixtures/ArtifactContract";
import { KeyGenerator } from "../core/security/KeyGenerator";
import { ArtifactRuntimeContract } from "../tests/fixtures/ArtifactRuntimeContract";
import assert from "node:assert/strict";

const target = Bun.argv[2] ?? "source";
if (!["source", "windows-x64"].includes(target))
	throw new Error("Unsupported local smoke target");
const fixture = new TestDatabase();
const runtime = new ArtifactRuntimeContract(fixture.database);
const master = new KeyGenerator().master();
const scratch = await mkdtemp(join(tmpdir(), "keyzori-artifact-"));
if (!relative(tmpdir(), scratch).startsWith("keyzori-artifact-"))
	throw new Error("Unsafe temporary artifact path");
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
	KZ_REDIS_URL: Bun.env.KZ_TEST_REDIS_URL,
	KZ_MASTER_KEY: master,
	KZ_API_HOST: "127.0.0.1",
	KZ_API_PORT: String(port),
	KZ_DATABASE_POOL_SIZE: "2",
	KZ_LOG_LEVEL: "error",
	NODE_EXTRA_CA_CERTS: join(scratch, "trusted.pem"),
	NODE_TLS_REJECT_UNAUTHORIZED: "1",
};
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
	await runtime.prepare(scratch);
	await fixture.start(false);
	let command: string[];
	if (target === "windows-x64") {
		const binary = join(scratch, "keyzori.exe");
		await copyFile(resolve("dist/server/keyzori-windows-x64.exe"), binary);
		command = [binary, "serve"];
	} else command = [process.execPath, resolve("src/main.ts"), "serve"];
	child = Bun.spawn(command, {
		env,
		cwd: scratch,
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = new URL(`http://127.0.0.1:${port}`);
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		try {
			if (
				(
					await fetch(new URL("/health", origin), {
						signal: AbortSignal.timeout(500),
					})
				).ok
			) {
				ready = true;
				break;
			}
		} catch {}
		if (child.exitCode !== null)
			throw new Error(`${target} exited during startup`);
		await Bun.sleep(100);
	}
	if (!ready) throw new Error(`${target} readiness timed out`);
	await new ArtifactContract(origin, master).run();
	await runtime.run();
	await runtime.prepareShutdown();
	let forced = false;
	const release = setTimeout(() => runtime.releaseShutdown(), 500);
	const force = setTimeout(() => {
		forced = true;
		child?.kill("SIGKILL");
	}, 30000);
	try {
		child.kill("SIGTERM");
		assert.equal(
			await child.exited,
			0,
			"Artifact did not exit cleanly on SIGTERM",
		);
		assert.equal(forced, false, "Artifact required forced shutdown");
		await runtime.verifyShutdown();
	} finally {
		clearTimeout(release);
		clearTimeout(force);
		runtime.releaseShutdown();
	}
	console.log(
		`${target}: migrations, HTTP/calendar parity, trusted/untrusted TLS, actual cron and graceful drain passed outside the checkout`,
	);
} finally {
	if (child && child.exitCode === null) {
		child.kill("SIGKILL");
		await child.exited;
	}
	await runtime.close();
	await fixture.stop();
	await rm(scratch, { recursive: true, force: true });
}
