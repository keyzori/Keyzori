import assert from "node:assert/strict";

const directory = "src/core/database/migrations";
function git(...args: string[]) {
	const command = Bun.spawnSync(["git", ...args], { timeout: 15000 });
	if (command.exitCode !== 0)
		throw new Error(`Cannot read trusted Git history (${args[0]})`);
	return command.stdout.toString().trimEnd();
}
function trees(revision: string) {
	return git("ls-tree", "-z", `${revision}:${directory}`)
		.split("\0")
		.filter(Boolean);
}

/** Directory tree IDs cover both the SQL and the generator's immutable snapshot. */
export function requirePrefix(accepted: string[], candidate: string[]) {
	assert.ok(candidate.length, "No v3 migrations in candidate");
	let last = "";
	for (const entry of candidate) {
		const timestamp = /^040000 tree [0-9a-f]{40,64}\t(\d{14})_[a-z0-9_]+$/.exec(
			entry,
		)?.[1];
		assert.ok(timestamp && timestamp > last, "Invalid v3 migration order");
		last = timestamp;
	}
	assert.deepEqual(
		candidate.slice(0, accepted.length),
		accepted,
		"The accepted v3 migration prefix was edited, deleted, renamed or reordered",
	);
}

if (import.meta.main) {
	const supplied = Bun.env.KZ_MIGRATION_BASE;
	if (supplied && !/^[a-f0-9]{40}$/.test(supplied))
		throw new Error("Invalid migration base SHA");
	// A PR uses its base SHA; a push uses its previous tip. For a new branch use
	// its common ancestor with main. A manual main check compares its parent.
	let base = supplied && !/^0+$/.test(supplied) ? supplied : undefined;
	if (!base) {
		base =
			Bun.env.GITHUB_REF === "refs/heads/main"
				? git("rev-list", "--parents", "-1", "HEAD").split(" ")[1]
				: git("merge-base", "HEAD", "refs/remotes/origin/main");
	}
	const candidate = trees("HEAD");
	assert.match(
		JSON.parse(git("show", "HEAD:package.json")).version,
		/^3\./,
		"Candidate is not a v3 release",
	);
	let accepted: string[] = [];
	if (base) {
		const manifest = JSON.parse(git("show", `${base}:package.json`));
		if (typeof manifest.version !== "string")
			throw new Error("Invalid base manifest");
		if (/^3\./.test(manifest.version)) {
			accepted = trees(base);
			assert.ok(accepted.length, "Trusted v3 base has no migration history");
		} else {
			assert.match(manifest.version, /^[012]\./, "Unknown migration baseline");
		}
	}
	requirePrefix(accepted, candidate);
	console.log(
		`Verified ${accepted.length} accepted v3 migrations against ${base ?? "initial commit"}; candidate has ${candidate.length}`,
	);
}
