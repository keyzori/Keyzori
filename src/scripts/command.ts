export type CommandOptions = {
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	allowFailure?: boolean;
	signal?: AbortSignal;
};

async function tail(stream: ReadableStream<Uint8Array>, maximum = 8192) {
	const decoder = new TextDecoder();
	let result = "";
	for await (const chunk of stream)
		result = (result + decoder.decode(chunk, { stream: true })).slice(-maximum);
	return (result + decoder.decode()).slice(-maximum);
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
	const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
	const abort = () => child.kill("SIGKILL");
	options.signal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, options.timeoutMs ?? 30000);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			tail(child.stdout, 262144),
			tail(child.stderr),
		]);
		const output = stdout.trim();
		const diagnostic = sanitized(stderr, env).trim();
		options.signal?.throwIfAborted();
		if (timedOut || (code !== 0 && !options.allowFailure))
			throw new Error(
				`${args[0]} ${args[1] ?? ""} ${timedOut ? "timed out" : `failed (${code})`}${diagnostic ? `: ${diagnostic}` : ""}`,
			);
		return { code, output, diagnostic };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
