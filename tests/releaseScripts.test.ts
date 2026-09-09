import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("fresh release branches work and tagging uses the verified checkout", async () => {
	const root = await mkdtemp(join(tmpdir(), "keyzori-release-test-"));
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	const run = (args: string[]) => {
		const result = Bun.spawnSync(args, { cwd: repo });
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.toString());
		}
		return result.stdout.toString().trim();
	};
	try {
		await mkdir(repo);
		run(["git", "init", "--bare", remote]);
		run(["git", "init", "-b", "main"]);
		run(["git", "config", "user.name", "Release test"]);
		run(["git", "config", "user.email", "test@example.invalid"]);
		await cp(resolve("scripts"), join(repo, "scripts"), { recursive: true });
		for (const path of ["package.json"]) {
			await Bun.write(join(repo, path), JSON.stringify({ version: "0.5.0" }));
		}
		run(["git", "add", "."]);
		run(["git", "commit", "-m", "test: initial manifests"]);
		const initial = run(["git", "rev-parse", "HEAD"]);
		run(["git", "remote", "add", "origin", remote]);
		run(["git", "push", "-u", "origin", "main"]);
		run(["git", "switch", "-c", "codex/release-test"]);
		expect(
			run([process.execPath, "scripts/release.ts", "patch", "--dry-run"]),
		).toContain("0.5.0 → 0.5.1");
		run(["git", "switch", "main"]);
		for (const path of ["package.json"]) {
			await Bun.write(join(repo, path), JSON.stringify({ version: "0.5.1" }));
		}
		run(["git", "commit", "-am", "test: advance main"]);
		run(["git", "push", "origin", "main"]);
		run(["git", "checkout", "--detach", initial]);
		run([process.execPath, "scripts/tag.ts", "--from-manifest"]);
		expect(run(["git", "rev-parse", "v0.5.0^{commit}"])).toBe(initial);
		expect(
			run([process.execPath, "scripts/tag.ts", "--from-manifest"]),
		).toContain("already exists");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
