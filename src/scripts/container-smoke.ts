import { resolve, join, relative } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { TestDatabase } from "../tests/fixtures/TestDatabase";
import { ArtifactContract } from "../tests/fixtures/ArtifactContract";
import { KeyGenerator } from "../core/security/KeyGenerator";
import { ArtifactRuntimeContract } from "../tests/fixtures/ArtifactRuntimeContract";

const target = Bun.argv[2] ?? "image";
if (!["source", "image", "linux-x64", "linux-arm64"].includes(target))
	throw new Error("Unknown container target");
const fixture = new TestDatabase();
const runtime = new ArtifactRuntimeContract(fixture.database);
const scratch = await mkdtemp(join(tmpdir(), "keyzori-artifact-"));
if (!relative(tmpdir(), scratch).startsWith("keyzori-artifact-"))
	throw new Error("Unsafe temporary artifact path");
const name = `keyzori-artifact-${Bun.randomUUIDv7()}`;
const master = new KeyGenerator().master();
const databaseUrl = new URL(fixture.url);
databaseUrl.hostname =
	process.platform === "linux" ? "127.0.0.1" : "host.docker.internal";
const redisUrl = new URL(Bun.env.KZ_TEST_REDIS_URL ?? "");
redisUrl.hostname = databaseUrl.hostname;
const probe = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const hostPort = probe.port;
await probe.stop(true);
const env = {
	...Bun.env,
	KZ_DATABASE_URL: databaseUrl.href,
	KZ_REDIS_URL: redisUrl.href,
	KZ_MASTER_KEY: master,
	KZ_API_HOST: "0.0.0.0",
	KZ_API_PORT: process.platform === "linux" ? String(hostPort) : "6284",
	KZ_DATABASE_POOL_SIZE: "2",
	KZ_LOG_LEVEL: "error",
	NODE_EXTRA_CA_CERTS: "/fixture-ca.pem",
	NODE_TLS_REJECT_UNAUTHORIZED: "1",
};
async function docker(args: string[]) {
	const child = Bun.spawn(["docker", ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, output] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`Docker ${args[0]} failed`);
	return output.trim();
}
let containerStarted = false;
try {
	const certificate = await runtime.prepare(scratch, databaseUrl.hostname);
	await fixture.start(false);
	const common = [
		"run",
		"-d",
		"--name",
		name,
		...(process.platform === "linux"
			? ["--network", "host"]
			: [
					"--add-host",
					"host.docker.internal:host-gateway",
					"-p",
					"127.0.0.1::6284",
				]),
		"-e",
		"KZ_DATABASE_URL",
		"-e",
		"KZ_REDIS_URL",
		"-e",
		"KZ_MASTER_KEY",
		"-e",
		"KZ_API_HOST",
		"-e",
		"KZ_API_PORT",
		"-e",
		"KZ_DATABASE_POOL_SIZE",
		"-e",
		"KZ_LOG_LEVEL",
		"-e",
		"NODE_EXTRA_CA_CERTS",
		"-e",
		"NODE_TLS_REJECT_UNAUTHORIZED",
		"-v",
		`${certificate}:/fixture-ca.pem:ro`,
	];
	if (target === "image") await docker([...common, "keyzori-server:test"]);
	else if (target === "source")
		await docker([
			...common,
			"keyzori-server-build:test",
			"bun",
			"/app/src/main.ts",
			"serve",
		]);
	else
		await docker([
			...common,
			"--platform",
			target === "linux-x64" ? "linux/amd64" : "linux/arm64",
			"-v",
			`${resolve("dist/server")}:/artifact:ro`,
			"debian:bookworm-slim",
			`/artifact/keyzori-${target}`,
			"serve",
		]);
	containerStarted = true;
	const port =
		process.platform === "linux"
			? hostPort
			: (await docker(["port", name, "6284/tcp"])).split(":").at(-1);
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
		await Bun.sleep(100);
	}
	if (!ready) throw new Error(`${target} did not become healthy`);
	await new ArtifactContract(origin, master).run();
	await runtime.run();
	await runtime.prepareShutdown();
	const release = setTimeout(() => runtime.releaseShutdown(), 500);
	try {
		await docker(["stop", "-t", "30", name]);
		assert.equal(
			await docker(["inspect", "--format", "{{.State.ExitCode}}", name]),
			"0",
			"Container did not exit cleanly on SIGTERM",
		);
		await runtime.verifyShutdown();
	} finally {
		clearTimeout(release);
		runtime.releaseShutdown();
	}
	console.log(
		`${target}: migrations, HTTP/calendar parity, trusted/untrusted TLS, actual cron and graceful drain passed inside a container`,
	);
} finally {
	if (containerStarted) await docker(["rm", "-f", name]);
	await runtime.close();
	await fixture.stop();
	await rm(scratch, { recursive: true, force: true });
}
