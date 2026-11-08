import { expect, test } from "bun:test";
import { command } from "../../scripts/command";

test("fixture command diagnostics redact configured secrets and URL credentials", async () => {
	const result = await command(
		[
			process.execPath,
			"-e",
			"console.error(process.env.FIXTURE_SECRET, 'postgresql://user:password@example.invalid/database'); process.exit(2)",
		],
		{
			env: { ...Bun.env, FIXTURE_SECRET: "private-fixture-value" },
			allowFailure: true,
		},
	);
	expect(result.code).toBe(2);
	expect(result.diagnostic).toContain("[redacted]");
	expect(result.diagnostic).not.toContain("private-fixture-value");
	expect(result.diagnostic).not.toContain("user:password");
});

test("fixture command deadlines terminate a stuck process", async () => {
	await expect(
		command([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			timeoutMs: 100,
		}),
	).rejects.toThrow("timed out");
});

test("fixture command cancellation terminates an active process and rejects before spawning an aborted command", async () => {
	const cancellation = new AbortController();
	const pending = command(
		[process.execPath, "-e", "setInterval(() => {}, 1000)"],
		{
			signal: cancellation.signal,
		},
	);
	cancellation.abort(new Error("Interrupted fixture startup"));
	await expect(pending).rejects.toThrow("Interrupted fixture startup");
	await expect(
		command(["nonexistent-fixture-command"], { signal: cancellation.signal }),
	).rejects.toThrow("Interrupted fixture startup");
});

test("fixture command preserves internal stdout for structured parsing", async () => {
	const result = await command(
		[
			process.execPath,
			"-e",
			"console.log(JSON.stringify({ secret: process.env.FIXTURE_SECRET }))",
		],
		{ env: { ...Bun.env, FIXTURE_SECRET: "private-fixture-value" } },
	);
	expect(JSON.parse(result.output)).toEqual({
		secret: "private-fixture-value",
	});
});

test("fixture command output buffers stay bounded", async () => {
	const result = await command([
		process.execPath,
		"-e",
		"await Bun.write(Bun.stdout, 'x'.repeat(300000)); await Bun.write(Bun.stderr, 'y'.repeat(20000))",
	]);
	expect(result.output).toHaveLength(262144);
	expect(result.diagnostic).toHaveLength(8192);
});
