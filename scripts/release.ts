/**
 * Prepares a release on the integration branch.
 *
 *   bun run release patch              # bump, verify, commit, push, open the promotion PR
 *   bun run release v0.5.0 --dry-run   # show every action without touching the remote
 *   bun run release --from-commit      # read the directive from the HEAD commit message (CI)
 *
 * The tag itself is not created here. Pushing the bump to `main` is what makes
 * a release real, so `scripts/tag.ts` runs from the promotion branch afterwards
 * and only ever tags a commit that already declares the version.
 */

import {
	parseReleaseDirective,
	readReleaseVersion,
	resolveVersion,
} from "./releaseManifests.ts";

const VALUE_FLAGS = new Set(["--branch", "--base"]);

const argv = Bun.argv.slice(2);
const options = new Map<string, string | true>();
const positionals: string[] = [];

for (let index = 0; index < argv.length; index += 1) {
	const argument = argv[index] as string;
	if (!argument.startsWith("--")) {
		positionals.push(argument);
		continue;
	}
	if (VALUE_FLAGS.has(argument)) {
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`${argument} requires a value.`);
		}
		options.set(argument, value);
		index += 1;
		continue;
	}
	options.set(argument, true);
}

const dryRun = options.has("--dry-run");
const skipChecks = options.has("--no-checks");
const skipPromote = options.has("--no-promote");
const fromCommit = options.has("--from-commit");
const branch = (options.get("--branch") as string | undefined) ?? "dev";
const base = (options.get("--base") as string | undefined) ?? "main";

async function run(
	description: string,
	command: () => Promise<unknown>,
): Promise<void> {
	if (dryRun) {
		console.log(`[dry-run] ${description}`);
		return;
	}
	console.log(`→ ${description}`);
	await command();
}

const directive = fromCommit
	? parseReleaseDirective((await Bun.$`git log -1 --pretty=%B`.text()).trim())
	: positionals[0];

if (!directive) {
	if (fromCommit) {
		console.log("No release directive in the HEAD commit message; skipping.");
		process.exit(0);
	}
	throw new Error(
		"Usage: bun run release <major|minor|patch|X.Y.Z> [--dry-run] [--no-checks] [--no-promote]",
	);
}

// --- Preflight -------------------------------------------------------------

const currentBranch = (
	await Bun.$`git rev-parse --abbrev-ref HEAD`.text()
).trim();
if (currentBranch !== branch) {
	throw new Error(`Releases are prepared on ${branch}, not ${currentBranch}.`);
}

const dirty = (await Bun.$`git status --porcelain`.text()).trim();
if (dirty.length > 0) {
	throw new Error(`The working tree must be clean before releasing:\n${dirty}`);
}

await Bun.$`git fetch origin ${branch} ${base}`;
const behind = (
	await Bun.$`git rev-list --count HEAD..origin/${branch}`.text()
).trim();
if (behind !== "0") {
	throw new Error(
		`${branch} is ${behind} commit(s) behind origin/${branch}. Pull first.`,
	);
}

const previous = await readReleaseVersion();
const version = resolveVersion(previous, directive);
const tag = `v${version}`;

console.log(`Releasing ${previous} → ${version} (${branch} → ${base}).`);

// --- Bump ------------------------------------------------------------------

await run(`sync workspace manifests to ${version}`, async () => {
	await Bun.$`bun run scripts/syncVersions.ts ${version}`;
});

// --- Verify ----------------------------------------------------------------

if (skipChecks) {
	console.log("Skipping `bun run check` (--no-checks).");
} else {
	await run(
		"run typecheck, tests, coverage, release:verify, and Biome",
		async () => {
			await Bun.$`bun run check`;
		},
	);
}

// --- Commit ----------------------------------------------------------------

await run(`commit "chore(release): ${tag}" and push ${branch}`, async () => {
	await Bun.$`git add package.json apps/server/package.json apps/sdk/package.json bun.lock`;
	await Bun.$`git commit --message ${`chore(release): ${tag}`}`;
	await Bun.$`git push origin ${branch}`;
});

// --- Promote ---------------------------------------------------------------

if (skipPromote) {
	console.log(`Prepared ${tag} on ${branch}. Promote to ${base} when ready.`);
	process.exit(0);
}

await run(
	`open and auto-merge the ${branch} → ${base} pull request`,
	async () => {
		const existing = (
			await Bun.$`gh pr list --base ${base} --head ${branch} --state open --json number --jq ".[0].number"`.text()
		).trim();

		if (existing.length === 0) {
			await Bun.$`gh pr create --base ${base} --head ${branch} --title ${`release: ${tag}`} --body ${`Promotes \`${branch}\` to \`${base}\` for ${tag}.\n\nTagging runs automatically once this merges.`}`;
		} else {
			console.log(`Reusing open pull request #${existing}.`);
		}

		await Bun.$`gh pr merge ${branch} --squash --auto --subject ${`release: ${tag}`}`;
	},
);

console.log(
	`Prepared ${tag}. Once the ${base} pull request merges, the tag workflow publishes it.`,
);
