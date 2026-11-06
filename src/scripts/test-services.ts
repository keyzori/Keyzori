import { command } from "./command";

type FixtureState = { databaseUrl: string; redisUrl: string };
type FixtureOptions = {
	execute?: typeof command;
	startupTimeoutMs?: number;
	cleanupTimeoutMs?: number;
	probeDelayMs?: number;
};

async function settled<T>(promises: Promise<T>[]) {
	const results = await Promise.allSettled(promises);
	const errors = results.filter((result) => result.status === "rejected");
	if (errors.length)
		throw new AggregateError(
			errors.map((result) => result.reason),
			"Fixture commands failed",
		);
	return results.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
}

/** Every invocation owns unique containers; no shared mutable fixture-state file exists. */
export class TestServices {
	private readonly runId = Bun.randomUUIDv7();
	private readonly postgres = `keyzori-test-pg-${this.runId}`;
	private readonly redis = `keyzori-test-redis-${this.runId}`;
	private readonly password = Buffer.from(
		crypto.getRandomValues(new Uint8Array(24)),
	).toString("hex");
	private readonly env = { ...Bun.env, POSTGRES_PASSWORD: this.password };
	private readonly cancellation = new AbortController();
	private startup: Promise<FixtureState> | undefined;
	private stopping: Promise<void> | undefined;
	constructor(private readonly options: FixtureOptions = {}) {}
	private docker(args: string[], signal: AbortSignal, allowFailure = false) {
		return (this.options.execute ?? command)(["docker", ...args], {
			env: this.env,
			allowFailure,
			signal,
			timeoutMs: 60000,
		});
	}
	async start(signal?: AbortSignal) {
		if (this.stopping) throw new Error("Fixture run is already stopping");
		this.startup ??= this.launch(
			AbortSignal.any([
				this.cancellation.signal,
				AbortSignal.timeout(this.options.startupTimeoutMs ?? 90000),
				...(signal ? [signal] : []),
			]),
		);
		try {
			return await this.startup;
		} catch (error) {
			try {
				await this.stop();
			} catch (cleanup) {
				throw new AggregateError(
					[error, cleanup],
					"Fixture startup and cleanup failed",
				);
			}
			throw error;
		}
	}
	private async launch(signal: AbortSignal): Promise<FixtureState> {
		signal.throwIfAborted();
		await this.docker(
			[
				"run",
				"-d",
				"--name",
				this.postgres,
				"--label",
				`dev.keyzori.test-run=${this.runId}`,
				"-e",
				"POSTGRES_PASSWORD",
				"-e",
				"POSTGRES_DB=keyzori",
				"-p",
				"127.0.0.1::5432",
				"postgres:18.0@sha256:41fc5342eefba6cc2ccda736aaf034bbbb7c3df0fdb81516eba1ba33f360162c",
			],
			signal,
		);
		signal.throwIfAborted();
		await this.docker(
			[
				"run",
				"-d",
				"--name",
				this.redis,
				"--label",
				`dev.keyzori.test-run=${this.runId}`,
				"-p",
				"127.0.0.1::6379",
				"redis:8.2.1@sha256:5fa2edb1e408fa8235e6db8fab01d1afaaae96c9403ba67b70feceb8661e8621",
				"redis-server",
				"--save",
				"",
				"--appendonly",
				"no",
			],
			signal,
		);
		const [pg, redis] = await settled([
			this.docker(["port", this.postgres, "5432/tcp"], signal),
			this.docker(["port", this.redis, "6379/tcp"], signal),
		]);
		const pgPort = pg?.output.split(":").at(-1);
		const redisPort = redis?.output.split(":").at(-1);
		if (
			!pgPort ||
			!redisPort ||
			!/^\d+$/.test(pgPort) ||
			!/^\d+$/.test(redisPort)
		)
			throw new Error("Fixture ports unavailable");
		for (;;) {
			signal.throwIfAborted();
			const probes = await settled([
				this.docker(
					// The initialization server accepts Unix sockets before the final
					// TCP server is ready. Probe the same transport the tests will use.
					[
						"exec",
						this.postgres,
						"pg_isready",
						"-h",
						"127.0.0.1",
						"-p",
						"5432",
						"-d",
						"keyzori",
						"-U",
						"postgres",
					],
					signal,
					true,
				),
				this.docker(["exec", this.redis, "redis-cli", "PING"], signal, true),
			]);
			if (probes.every((probe) => probe.code === 0)) {
				signal.throwIfAborted();
				return {
					databaseUrl: `postgresql://postgres:${this.password}@127.0.0.1:${pgPort}/keyzori`,
					redisUrl: `redis://127.0.0.1:${redisPort}`,
				};
			}
			await Bun.sleep(this.options.probeDelayMs ?? 250);
		}
	}
	stop() {
		this.cancellation.abort(new Error("Fixture run interrupted"));
		this.stopping ??= this.cleanup();
		return this.stopping;
	}
	private async cleanup() {
		// Wait for startup's Docker commands to settle before looking for owned resources.
		await this.startup?.catch(() => {});
		const signal = AbortSignal.timeout(this.options.cleanupTimeoutMs ?? 20000);
		const results = await Promise.allSettled([
			...[this.postgres, this.redis].map(async (name) => {
				if (!/^keyzori-test-(pg|redis)-[0-9a-f-]{36}$/.test(name))
					throw new Error("Invalid fixture container name");
				const listed = await this.docker(
					["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"],
					signal,
				);
				if (!listed.output) return;
				if (listed.output !== name)
					throw new Error("Unexpected fixture container identity");
				const inspected = await this.docker(
					[
						"inspect",
						"--format",
						'{{.Id}} {{index .Config.Labels "dev.keyzori.test-run"}}',
						name,
					],
					signal,
				);
				const [id, owner] = inspected.output.split(" ");
				if (owner !== this.runId || !id || !/^[a-f0-9]{64}$/.test(id))
					throw new Error(
						"Refusing to remove a container owned by another run",
					);
				// Remove the inspected immutable ID, never a replaceable container name.
				await this.docker(["rm", "-f", id], signal);
			}),
			this.cleanupRuntime(signal),
		]);
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map((result) => result.reason),
				`Fixture cleanup failed for run ${this.runId}`,
			);
	}
	private async cleanupRuntime(signal: AbortSignal) {
		const failures: unknown[] = [];
		for (const kind of ["container", "network"] as const) {
			try {
				const listed = await this.docker(
					[
						...(kind === "container" ? ["ps", "-a"] : ["network", "ls"]),
						"--filter",
						`label=dev.keyzori.test-run=${this.runId}`,
						"--format",
						kind === "container" ? "{{.Names}}" : "{{.Name}}",
					],
					signal,
				);
				const names = listed.output
					.split("\n")
					.filter((name) => /^keyzori-(tls|smoke)-[0-9a-f-]{36}$/.test(name));
				const results = await Promise.allSettled(
					names.map(async (name) => {
						const inspected = await this.docker(
							[
								...(kind === "network" ? ["network"] : []),
								"inspect",
								"--format",
								kind === "container"
									? '{{.Id}} {{index .Config.Labels "dev.keyzori.test-run"}}'
									: '{{.Id}} {{index .Labels "dev.keyzori.test-run"}}',
								name,
							],
							signal,
						);
						const [id, owner] = inspected.output.split(" ");
						if (owner !== this.runId || !id || !/^[a-f0-9]{64}$/.test(id))
							throw new Error("Refusing foreign runtime fixture cleanup");
						await this.docker(
							kind === "container" ? ["rm", "-f", id] : ["network", "rm", id],
							signal,
						);
					}),
				);
				for (const result of results)
					if (result.status === "rejected") failures.push(result.reason);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length)
			throw new AggregateError(
				failures,
				"Owned runtime fixture cleanup failed",
			);
	}
	async run(args: string[]) {
		let child: ReturnType<typeof Bun.spawn> | undefined;
		let interrupted = false;
		let timedOut = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const interrupt = () => {
			interrupted = true;
			this.cancellation.abort(new Error("Fixture run interrupted"));
			child?.kill("SIGTERM");
			if (child && !killTimer)
				killTimer = setTimeout(() => child?.kill("SIGKILL"), 30000);
		};
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", interrupt);
		const deadline = setTimeout(
			() => {
				timedOut = true;
				interrupt();
			},
			15 * 60 * 1000,
		);
		const failures: unknown[] = [];
		try {
			const state = await this.start();
			this.cancellation.signal.throwIfAborted();
			child = Bun.spawn(args, {
				env: {
					...Bun.env,
					KZ_TEST_DATABASE_URL: state.databaseUrl,
					KZ_TEST_REDIS_URL: state.redisUrl,
					KZ_TEST_RUN_ID: this.runId,
				},
				stdout: "inherit",
				stderr: "inherit",
			});
			const code = await child.exited;
			if (timedOut)
				throw new Error("Fixture command exceeded its 15-minute deadline");
			process.exitCode = interrupted ? 130 : code;
		} catch (error) {
			failures.push(error);
		} finally {
			clearTimeout(deadline);
			clearTimeout(killTimer);
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
			try {
				await this.stop();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length)
			throw new AggregateError(failures, "Fixture command or cleanup failed");
	}
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	if (args[0] !== "exec" || !args[1])
		throw new Error(
			"Use test-services.ts exec <command>; fixtures are owned and cleaned up by that invocation",
		);
	await new TestServices().run(args.slice(1));
}
