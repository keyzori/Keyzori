import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { KeyGenerator } from "../core/security/KeyGenerator";
import { RuntimeContract } from "../tests/fixtures/RuntimeContract";
import { command } from "./command";

const project = `keyzori-compose-${Bun.randomUUIDv7()}`;
const scratch = await mkdtemp(join(tmpdir(), "keyzori-compose-"));
if (
	!relative(tmpdir(), scratch).startsWith("keyzori-compose-") ||
	!/^keyzori-compose-[0-9a-f-]{36}$/.test(project)
)
	throw new Error("Unsafe temporary Compose identity");
const file = join(scratch, "compose.json");
const master = new KeyGenerator().master();
const secret = () =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const env = {
	...Bun.env,
	KZ_MASTER_KEY: master,
	KZ_POSTGRES_PASSWORD: secret(),
	KZ_SERVER_DATABASE_PASSWORD: secret(),
	KZ_MIGRATION_DATABASE_PASSWORD: secret(),
	KZ_WEBHOOK_ENCRYPTION_KEY: secret(),
	KZ_VERSION: "smoke",
};
const cancellation = new AbortController();
let phaseSignal = cancellation.signal;
const interrupt = () =>
	cancellation.abort(new Error("Compose smoke interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const docker = async (args: string[]) =>
	(
		await command(["docker", ...args], {
			env,
			timeoutMs: 180000,
			signal: phaseSignal,
		})
	).output;
const compose = (args: string[]) =>
	docker(["compose", "-p", project, "-f", file, ...args]);
const object = (value: unknown): Record<string, unknown> => {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return Object.fromEntries(Object.entries(value));
};
async function origin() {
	const port = (await compose(["port", "server", "6284"])).split(":").at(-1);
	assert.ok(port && /^\d+$/.test(port));
	return new URL(`http://127.0.0.1:${port}`);
}
const failures: unknown[] = [];
try {
	const config = object(
		JSON.parse(
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
		),
	);
	const services = object(config.services);
	assert.equal(object(services.postgres).ports, undefined);
	assert.equal(object(services.redis).ports, undefined);
	const server = object(services.server);
	assert.equal(server.read_only, true);
	server.image = "keyzori-server:test";
	delete server.build;
	server.ports = [
		{ target: 6284, published: "0", host_ip: "127.0.0.1", protocol: "tcp" },
	];
	const migrator = object(services.migrate);
	migrator.image = "keyzori-server:test";
	delete migrator.build;
	services.server = server;
	services.migrate = migrator;
	config.services = services;
	await Bun.write(file, JSON.stringify(config));
	await compose(["up", "-d", "--wait", "--wait-timeout", "90"]);
	const contract = new RuntimeContract(await origin(), master);
	const id = await contract.run();
	const privileges = await compose([
		"exec",
		"-T",
		"postgres",
		"psql",
		"-U",
		"keyzori",
		"-d",
		"keyzori",
		"-Atc",
		"select has_schema_privilege('keyzori_server','public','CREATE'), has_table_privilege('keyzori_server','drizzle.__drizzle_migrations','UPDATE'), has_table_privilege('keyzori_server','audit_logs','UPDATE'), has_table_privilege('keyzori_server','audit_logs','DELETE'), has_table_privilege('keyzori_server','usage_operations','UPDATE'), has_table_privilege('keyzori_server','usage_operations','DELETE')",
	]);
	assert.equal(
		privileges,
		"f|f|f|f|f|f",
		"Runtime role must not own schema, migration history, or mutate append-only history",
	);
	const container = await compose(["ps", "-q", "server"]);
	assert.equal(
		await docker([
			"inspect",
			"--format",
			"{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}",
			container,
		]),
		"65532:65532 true",
	);
	const stream = await contract.prepareShutdown();
	try {
		await compose(["down", "--timeout", "30"]);
		assert.equal(await stream.closeCode(), 1012);
	} finally {
		stream.close();
	}
	await compose(["up", "-d", "--wait", "--wait-timeout", "90"]);
	const persisted = await new RuntimeContract(await origin(), master).data(
		`/licenses/${id}`,
	);
	assert.equal(persisted.id, id);
	assert.equal(persisted.enabled, false);
	console.log(
		"Compose smoke passed: migration/runtime roles, source image, persistence and disabled-key retention",
	);
} catch (error) {
	failures.push(error);
} finally {
	process.removeListener("SIGINT", interrupt);
	process.removeListener("SIGTERM", interrupt);
	phaseSignal = AbortSignal.timeout(60000);
	try {
		if (await Bun.file(file).exists())
			await compose(["down", "--volumes", "--timeout", "30"]);
	} catch (error) {
		failures.push(error);
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch((error) =>
			failures.push(error),
		);
	}
}
if (failures.length)
	throw new AggregateError(failures, "Compose smoke or cleanup failed");
