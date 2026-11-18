import { expect, test } from "bun:test";
import { command } from "../../scripts/command";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test.each(["waiting", "exited"])(
	"an owned descendant cannot keep pipes or run after its %s parent",
	async (state) => {
		const dir = await mkdtemp(join(tmpdir(), "keyzori-command-"));
		const ready = join(dir, "ready"),
			late = join(dir, "late");
		const descendant = `await Bun.write(${JSON.stringify(ready)}, String(Date.now())); await Bun.sleep(1700); await Bun.write(${JSON.stringify(late)}, "survived")`;
		const parent = `Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendant)}], {stdout:"inherit",stderr:"inherit"}); while (!(await Bun.file(${JSON.stringify(ready)}).exists())) await Bun.sleep(5); ${state === "exited" ? "process.exit(0)" : "await Bun.sleep(5000)"}`;
		try {
			const started = Date.now();
			const pending = command([process.execPath, "-e", parent], {
				timeoutMs: 1000,
			});
			// Windows job teardown already kills orphans on supervisor exit; POSIX
			// keeps the inherited pipe open until the deadline kills the process group.
			if (state === "exited" && process.platform === "win32")
				expect((await pending).code).toBe(0);
			else await expect(pending).rejects.toThrow("timed out");
			expect(Date.now() - started).toBeLessThan(2200);
			expect(await Bun.file(ready).exists()).toBe(true);
			await Bun.sleep(
				Math.max(1, Number(await Bun.file(ready).text()) + 1900 - Date.now()),
			);
			expect(await Bun.file(late).exists()).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);
