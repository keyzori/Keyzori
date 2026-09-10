if (
	!process.env.KEYZORI_TEST_DATABASE_URL ||
	!process.env.KEYZORI_TEST_REDIS_URL
)
	throw new Error(
		"Set KEYZORI_TEST_DATABASE_URL and KEYZORI_TEST_REDIS_URL to isolated local test services.",
	);
const args = process.argv.slice(2);
const child = Bun.spawn(
	[process.execPath, "test", ...(args.length ? args : ["tests"])],
	{
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	},
);
process.exitCode = await child.exited;
