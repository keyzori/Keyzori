import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { KeyGenerator } from "../core/security/KeyGenerator";
import { ArtifactContract } from "../tests/fixtures/ArtifactContract";

const project = `keyzori-compose-${Bun.randomUUIDv7()}`;
const scratch = await mkdtemp(join(tmpdir(), "keyzori-compose-"));
if (!relative(tmpdir(), scratch).startsWith("keyzori-compose-"))
	throw new Error("Unsafe temporary Compose path");
const file = join(scratch, "compose.json");
const master = new KeyGenerator().master();
const env = {
	...Bun.env,
	KZ_MASTER_KEY: master,
	KZ_POSTGRES_PASSWORD: Buffer.from(
		crypto.getRandomValues(new Uint8Array(24)),
	).toString("hex"),
	KZ_SERVER_DATABASE_PASSWORD: Buffer.from(
		crypto.getRandomValues(new Uint8Array(24)),
	).toString("hex"),
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
	if (code !== 0) throw new Error(`Compose smoke command failed: ${args[0]}`);
	return output.trim();
}
function compose(args: string[]) {
	return docker(["compose", "-p", project, "-f", file, ...args]);
}
async function origin() {
	const port = (await compose(["port", "server", "6284"])).split(":").at(-1);
	return new URL(`http://127.0.0.1:${port}`);
}
try {
	const config = JSON.parse(
		await docker([
			"compose",
			"-p",
			project,
			"-f",
			resolve("compose.yml"),
			"config",
			"--format",
			"json",
		]),
	);
	assert.equal(config.services.postgres.ports, undefined);
	assert.equal(config.services.redis.ports, undefined);
	assert.equal(config.services.server.read_only, true);
	config.services.server.image = "keyzori-server:test";
	delete config.services.server.build;
	config.services.server.ports = [
		{ target: 6284, published: "0", host_ip: "127.0.0.1", protocol: "tcp" },
	];
	await Bun.write(file, JSON.stringify(config));
	await compose(["up", "-d", "--wait", "--wait-timeout", "90"]);
	let base = await origin();
	await new ArtifactContract(base, master).run();
	const headers = {
		Authorization: `Bearer ${master}`,
		"Content-Type": "application/json",
		"Idempotency-Key": Bun.randomUUIDv7(),
	};
	const created = await fetch(new URL("/licenses", base), {
		method: "POST",
		headers,
		body: JSON.stringify({ notes: "Compose persistence" }),
	});
	assert.equal(created.status, 200);
	const issued = await created.json();
	const container = await compose(["ps", "-q", "server"]);
	const [inspection] = JSON.parse(await docker(["inspect", container]));
	assert.equal(inspection.Config.User, "65532:65532");
	assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
	await compose(["down", "--timeout", "30"]);
	await compose(["up", "-d", "--wait", "--wait-timeout", "90"]);
	base = await origin();
	const persisted = await fetch(
		new URL(`/licenses?id=${issued.data.id}`, base),
		{ headers },
	);
	assert.equal(persisted.status, 200);
	assert.equal((await persisted.json()).data.notes, "Compose persistence");
	console.log(
		"Compose: isolated fresh deployment, non-root read-only image, HTTP parity and PostgreSQL persistence passed",
	);
} finally {
	if (await Bun.file(file).exists())
		await compose(["down", "--volumes", "--timeout", "30"]);
	await rm(scratch, { recursive: true, force: true });
}
