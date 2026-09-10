import { resolve } from "node:path";
import { existsSync } from "node:fs";

const root = resolve(import.meta.dir, "..");
if (!existsSync(resolve(root, "node_modules/elysia")))
	throw new Error("Run bun run setup before local infrastructure tests.");
const id = `keyzori-test-${crypto.randomUUID().slice(0, 8)}`;
const containers = [`${id}-tests`, `${id}-postgres`, `${id}-redis`] as const;
async function docker(...args: string[]) {
	const child = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [output, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code) throw new Error(`Docker ${args[0]} failed: ${error.trim()}`);
	return output.trim();
}
async function ready(container: string, command: string[]) {
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			await docker("exec", container, ...command);
			return;
		} catch {
			await Bun.sleep(250);
		}
	}
	throw new Error(`Test dependency ${container} did not become ready.`);
}
try {
	await docker("network", "create", id);
	await docker(
		"run",
		"-d",
		"--name",
		containers[1],
		"--network",
		id,
		"--network-alias",
		"postgres",
		"-e",
		"POSTGRES_PASSWORD=local-test-only",
		"postgres:18-alpine",
	);
	await docker(
		"run",
		"-d",
		"--name",
		containers[2],
		"--network",
		id,
		"--network-alias",
		"redis",
		"redis:8-alpine",
	);
	await Promise.all([
		ready(containers[1], ["pg_isready", "-U", "postgres"]),
		ready(containers[2], ["redis-cli", "ping"]),
	]);
	const args = process.argv.slice(2);
	const child = Bun.spawn(
		[
			"docker",
			"run",
			"--rm",
			"--name",
			containers[0],
			"--network",
			id,
			"--mount",
			`type=bind,source=${root},target=/app`,
			"-w",
			"/app",
			"-e",
			"KEYZORI_TEST_DATABASE_URL=postgresql://postgres:local-test-only@postgres:5432/postgres",
			"-e",
			"KEYZORI_TEST_REDIS_URL=redis://redis:6379",
			"oven/bun:1.4.2-alpine",
			"bun",
			"run",
			"scripts/integration.ts",
			...(args.length
				? args
				: [
						"tests",
						"--coverage",
						"--coverage-reporter=text",
						"--coverage-reporter=lcov",
					]),
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	process.exitCode = await child.exited;
} finally {
	for (const name of containers) {
		try {
			await docker("rm", "-f", "-v", name);
		} catch {
			/* already removed */
		}
	}
	try {
		await docker("network", "rm", id);
	} catch {
		/* already removed */
	}
}
