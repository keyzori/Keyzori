export type CommandOptions = {
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	allowFailure?: boolean;
	signal?: AbortSignal;
};

function tail(stream: ReadableStream<Uint8Array>, maximum = 8192) {
	const reader = stream.getReader();
	const done = (async () => {
		const decoder = new TextDecoder();
		let result = "";
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				result = (result + decoder.decode(chunk.value, { stream: true })).slice(
					-maximum,
				);
			}
			return (result + decoder.decode()).slice(-maximum);
		} finally {
			reader.releaseLock();
		}
	})();
	return { done, cancel: () => void reader.cancel().catch(() => {}) };
}

/** A Windows job contains descendants even if an intermediate process has already exited. */
export function ownedCommand(args: string[]) {
	return process.platform === "win32"
		? [
				process.execPath,
				"--no-env-file",
				import.meta.path,
				"--windows-job",
				...args,
			]
		: args;
}

export function signalOwned(
	child: Pick<Bun.Subprocess, "pid" | "kill">,
	signal: "SIGTERM" | "SIGKILL",
) {
	if (process.platform === "win32") return child.kill(signal);
	try {
		// Bun.spawn(detached: true) setsid() before executing the child.
		process.kill(-child.pid, signal);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
			throw error;
	}
}

async function windowsJob(args: string[]) {
	if (process.platform !== "win32" || !args.length || process.arch === "ia32")
		throw new Error("Invalid Windows fixture supervisor");
	const { dlopen } = await import("bun:ffi");
	const { symbols } = dlopen("kernel32", {
		CreateJobObjectW: { args: ["ptr", "ptr"], returns: "i64" },
		GetCurrentProcess: { args: [], returns: "i64" },
		SetInformationJobObject: {
			args: ["i64", "u32", "ptr", "u32"],
			returns: "i32",
		},
		AssignProcessToJobObject: { args: ["i64", "i64"], returns: "i32" },
	});
	const job = symbols.CreateJobObjectW(null, null);
	// JOBOBJECT_EXTENDED_LIMIT_INFORMATION (Win64 ABI): BasicLimitInformation.LimitFlags.
	const limits = new Uint8Array(144);
	new DataView(limits.buffer).setUint32(16, 0x2000, true); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if (
		!job ||
		!symbols.SetInformationJobObject(job, 9, limits, limits.length) ||
		!symbols.AssignProcessToJobObject(job, symbols.GetCurrentProcess())
	)
		throw new Error("Cannot contain the Windows fixture process tree");
	// The supervisor owns the only job handle. OS teardown closes it on exit or
	// forced termination, including if the original child left grandchildren.
	const child = Bun.spawn(args, {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(await child.exited);
}

function sanitized(value: string, env: Record<string, string | undefined>) {
	let result = value.replace(
		/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
		"$1[redacted]@",
	);
	for (const [name, secret] of Object.entries(env)) {
		if (
			/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL|REDIS_URL/.test(name) &&
			secret &&
			secret.length >= 8
		)
			result = result.replaceAll(secret, "[redacted]");
	}
	return result;
}

/** Returns bounded stdout for internal parsing and credential-redacted error diagnostics. */
export async function command(args: string[], options: CommandOptions = {}) {
	options.signal?.throwIfAborted();
	const env = options.env ?? Bun.env;
	const child = Bun.spawn(ownedCommand(args), {
		env,
		detached: process.platform !== "win32",
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = tail(child.stdout, 262144);
	const stderr = tail(child.stderr);
	const interrupted = Promise.withResolvers<never>();
	const abort = () => interrupted.reject(options.signal?.reason);
	options.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() =>
			interrupted.reject(new Error(`${args[0]} ${args[1] ?? ""} timed out`)),
		options.timeoutMs ?? 30000,
	);
	try {
		const [code, out, err] = await Promise.race([
			Promise.all([child.exited, stdout.done, stderr.done]),
			interrupted.promise,
		]);
		const output = out.trim();
		const diagnostic = sanitized(err, env).trim();
		if (code !== 0 && !options.allowFailure)
			throw new Error(
				`${args[0]} ${args[1] ?? ""} failed (${code})${diagnostic ? `: ${diagnostic}` : ""}`,
			);
		return { code, output, diagnostic };
	} catch (error) {
		signalOwned(child, "SIGKILL");
		stdout.cancel();
		stderr.cancel();
		let reap: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				child.exited,
				new Promise<void>((resolve) => {
					reap = setTimeout(resolve, 1000);
				}),
			]);
		} finally {
			clearTimeout(reap);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}

if (import.meta.main) {
	if (Bun.argv[2] !== "--windows-job")
		throw new Error("Invalid fixture command");
	await windowsJob(Bun.argv.slice(3));
}
