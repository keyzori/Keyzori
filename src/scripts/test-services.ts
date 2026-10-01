class TestServices {
	private get stateFile() {
		return Bun.file(
			new URL("../../.cache/server-fixtures.json", import.meta.url),
		);
	}
	private async command(args: string[]) {
		const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
		const [code, output] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		if (code !== 0)
			throw new Error(`Fixture command failed: ${args[0]} ${args[1]}`);
		return output.trim();
	}
	async start() {
		if (await this.stateFile.exists())
			throw new Error(
				"Fixture record already exists; stop those fixtures first",
			);
		const suffix = Bun.randomUUIDv7();
		const postgres = `keyzori-test-pg-${suffix}`;
		const redis = `keyzori-test-redis-${suffix}`;
		const password = Buffer.from(
			crypto.getRandomValues(new Uint8Array(24)),
		).toString("hex");
		try {
			await this.command([
				"docker",
				"run",
				"-d",
				"--name",
				postgres,
				"-e",
				`POSTGRES_PASSWORD=${password}`,
				"-e",
				"POSTGRES_DB=keyzori",
				"-p",
				"127.0.0.1::5432",
				"postgres:18.0",
			]);
			await this.command([
				"docker",
				"run",
				"-d",
				"--name",
				redis,
				"-p",
				"127.0.0.1::6379",
				"redis:8.2.1",
				"redis-server",
				"--save",
				"",
				"--appendonly",
				"no",
			]);
			const pgPort = (
				await this.command(["docker", "port", postgres, "5432/tcp"])
			)
				.split(":")
				.at(-1);
			const redisPort = (
				await this.command(["docker", "port", redis, "6379/tcp"])
			)
				.split(":")
				.at(-1);
			if (!pgPort || !redisPort) throw new Error("Fixture port unavailable");
			await Bun.write(
				this.stateFile,
				JSON.stringify({
					postgres,
					redis,
					databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${pgPort}/keyzori`,
					redisUrl: `redis://127.0.0.1:${redisPort}`,
				}),
			);
			for (let attempt = 0; attempt < 60; attempt++) {
				try {
					await this.command([
						"docker",
						"exec",
						postgres,
						"pg_isready",
						"-U",
						"postgres",
					]);
					await this.command(["docker", "exec", redis, "redis-cli", "PING"]);
					console.log("Isolated PostgreSQL 18.0 and Redis 8.2.1 are ready");
					return;
				} catch {
					await Bun.sleep(500);
				}
			}
			throw new Error("Fixtures did not become ready");
		} catch (error) {
			await Promise.allSettled([
				this.command(["docker", "rm", "-f", postgres]),
				this.command(["docker", "rm", "-f", redis]),
			]);
			await this.stateFile.delete().catch(() => undefined);
			throw error;
		}
	}
	async stop() {
		if (!(await this.stateFile.exists())) return;
		const state = await this.stateFile.json();
		for (const name of [state.postgres, state.redis]) {
			if (
				typeof name !== "string" ||
				!/^keyzori-test-(pg|redis)-[0-9a-f-]{36}$/.test(name)
			)
				throw new Error("Invalid fixture container record");
			await this.command(["docker", "rm", "-f", name]);
		}
		await this.stateFile.delete();
	}
	async run(command: string[]) {
		await this.start();
		try {
			const state = await this.stateFile.json();
			const child = Bun.spawn(command, {
				env: {
					...Bun.env,
					KZ_TEST_DATABASE_URL: state.databaseUrl,
					KZ_TEST_REDIS_URL: state.redisUrl,
				},
				stdout: "inherit",
				stderr: "inherit",
			});
			process.exitCode = await child.exited;
		} finally {
			await this.stop();
		}
	}
}

if (import.meta.main) {
	const services = new TestServices();
	const command = Bun.argv[2] ?? "run";
	if (command === "start") await services.start();
	else if (command === "stop") await services.stop();
	else if (command === "run")
		await services.run([process.execPath, "test", "src/tests"]);
	else if (command === "exec" && Bun.argv[3])
		await services.run(Bun.argv.slice(3));
	else throw new Error("Use start, stop, run, or exec <command>");
}
