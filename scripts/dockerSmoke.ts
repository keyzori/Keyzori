import { createHmac } from "node:crypto";
import { composeSmoke } from "./composeSmoke.ts";

const id = `keyzori-smoke-${crypto.randomUUID().slice(0, 8)}`;
const image = process.env.KEYZORI_SMOKE_IMAGE ?? "keyzori-rebuild";
const names = {
	postgres: `${id}-pg`,
	redis: `${id}-redis`,
	server: `${id}-app`,
};
const admin = "docker-smoke-test-only-admin-key-32-characters";
async function docker(...args: string[]) {
	const process = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code) throw new Error(`Docker ${args[0]} failed: ${err.trim()}`);
	return out.trim();
}
async function ready(url: string) {
	for (let attempt = 0; attempt < 120; attempt++) {
		try {
			if (
				(await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1000) })).ok
			)
				return;
		} catch {
			/* starting */
		}
		await Bun.sleep(250);
	}
	throw new Error("Container did not become ready.");
}
try {
	await docker("network", "create", id);
	await docker(
		"run",
		"-d",
		"--name",
		names.postgres,
		"--network",
		id,
		"-e",
		"POSTGRES_PASSWORD=smoke-only",
		"-e",
		"POSTGRES_DB=keyzori",
		"postgres:18",
	);
	await docker("run", "-d", "--name", names.redis, "--network", id, "redis:8");
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			await docker("exec", names.postgres, "pg_isready", "-U", "postgres");
			break;
		} catch {
			await Bun.sleep(250);
		}
	}
	const user = await docker(
		"image",
		"inspect",
		"--format",
		"{{.Config.User}}",
		image,
	);
	if (!user || /^(root|0)(:|$)/.test(user))
		throw new Error("Image must run as non-root.");
	await docker(
		"run",
		"--rm",
		"--entrypoint",
		"bun",
		image,
		"-e",
		'import { existsSync } from "node:fs"; const pkg = await Bun.file("/app/package.json").json(); if (!existsSync("/app/src/main.ts") || pkg.scripts?.build) throw new Error("Image must run source"); for (const path of ["dist", "tests", ".env", "node_modules/typescript", "node_modules/@biomejs/biome", "node_modules/drizzle-kit"]) if (existsSync("/app/" + path)) throw new Error("Unexpected runtime file: " + path);',
	);
	await docker(
		"run",
		"-d",
		"--name",
		names.server,
		"--network",
		id,
		"--read-only",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,size=16m",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges:true",
		"-p",
		"127.0.0.1::3000",
		"-e",
		`KEYZORI_DATABASE_URL=postgresql://postgres:smoke-only@${names.postgres}:5432/keyzori`,
		"-e",
		`KEYZORI_REDIS_URL=redis://${names.redis}:6379`,
		"-e",
		`KEYZORI_ADMIN_KEY=${admin}`,
		"-e",
		"KEYZORI_PLUGINS=stripe",
		"-e",
		"KEYZORI_STRIPE_SECRET_KEY=sk_test_fake",
		"-e",
		"KEYZORI_STRIPE_WEBHOOK_SECRET=whsec_smoke",
		image,
	);
	const port = (await docker("port", names.server, "3000/tcp"))
		.split(":")
		.at(-1);
	let url = `http://127.0.0.1:${port}`;
	await ready(url);
	await composeSmoke(docker, image);
	const customer = await fetch(`${url}/admin/customers`, {
		method: "POST",
		headers: { "X-Admin-Key": admin, "content-type": "application/json" },
		body: JSON.stringify({ email: "smoke@example.com", name: "Smoke" }),
	});
	if (customer.status !== 201) throw new Error("Container admin API failed.");
	const { id: customerId } = await customer.json();
	const cli = await docker(
		"run",
		"--rm",
		"--network",
		id,
		"-e",
		`KEYZORI_URL=http://${names.server}:3000`,
		"-e",
		`KEYZORI_ADMIN_KEY=${admin}`,
		image,
		"admin",
		"customers",
		"get",
		customerId,
	);
	if (JSON.parse(cli).id !== customerId)
		throw new Error("Container CLI failed.");
	const raw = JSON.stringify({
		id: "evt_smoke",
		type: "test.ignored",
		data: { object: {} },
	});
	const time = Math.floor(Date.now() / 1000);
	const signature = createHmac("sha256", "whsec_smoke")
		.update(`${time}.${raw}`)
		.digest("hex");
	if (
		!(
			await fetch(`${url}/plugins/stripe/webhook`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"stripe-signature": `t=${time},v1=${signature}`,
				},
				body: raw,
			})
		).ok
	)
		throw new Error("Container webhook failed.");
	if (!(await fetch(`${url}/openapi.json`)).ok)
		throw new Error("Container OpenAPI failed.");
	await docker("restart", "--time", "20", names.server);
	url = `http://127.0.0.1:${(await docker("port", names.server, "3000/tcp")).split(":").at(-1)}`;
	await ready(url);
	if (
		!(
			await fetch(`${url}/admin/customers/${customerId}`, {
				headers: { "X-Admin-Key": admin },
			})
		).ok
	)
		throw new Error("Repeated startup lost data.");
	await docker("exec", names.server, "bun", "src/main.ts", "healthcheck");
	await docker("stop", "--time", "20", names.server);
	if (
		(await docker(
			"inspect",
			"--format",
			"{{.State.ExitCode}}",
			names.server,
		)) !== "0"
	)
		throw new Error("Graceful shutdown failed.");
	console.log(
		"Docker smoke passed: migrations, non-root/read-only runtime, CLI, signed webhook, restart, and graceful shutdown.",
	);
} catch (error) {
	try {
		console.error(await docker("logs", "--tail", "30", names.server));
	} catch {
		/* no container */
	}
	throw error;
} finally {
	for (const name of Object.values(names)) {
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
