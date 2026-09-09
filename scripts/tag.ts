/**
 * Creates and pushes an annotated release tag on the checked-out main commit.
 *
 *   bun run scripts/tag.ts v0.5.0        # tag an explicit version
 *   bun run scripts/tag.ts --from-manifest   # tag whatever HEAD declares
 *
 * Every manifest on HEAD is checked against the tag first, so a tag
 * whose version does not match the branch it points at is rejected here rather
 * than eight minutes into the release workflow. Tagging is idempotent: an
 * existing remote tag is left alone, which lets this run on every push to main.
 */

import {
	type PackageManifest,
	RELEASE_MANIFESTS,
	RELEASE_TAG_PATTERN,
} from "./releaseManifests.ts";

const args = Bun.argv.slice(2);
const fromManifest = args.includes("--from-manifest");
const requested = args.find((argument) => !argument.startsWith("--"));

if (!fromManifest && (!requested || !RELEASE_TAG_PATTERN.test(requested))) {
	throw new Error(
		"Usage: bun scripts/tag.ts <vMAJOR.MINOR.PATCH | --from-manifest>",
	);
}

await Bun.$`git fetch origin main`;
// Freeze the checkout selected by CI, even if main advances during this run.
const target = (await Bun.$`git rev-parse HEAD`.text()).trim();
await Bun.$`git merge-base --is-ancestor ${target} origin/main`;

const manifests = new Map<string, PackageManifest>();
for (const path of RELEASE_MANIFESTS) {
	manifests.set(path, await Bun.$`git show ${target}:${path}`.json());
}

const declared = manifests.get(RELEASE_MANIFESTS[0])?.version;
if (!declared) {
	throw new Error(`origin/main:${RELEASE_MANIFESTS[0]} declares no version.`);
}

const tag = fromManifest ? `v${declared}` : (requested as string);
if (!RELEASE_TAG_PATTERN.test(tag)) {
	throw new Error(`origin/main declares an untaggable version: ${declared}`);
}

const mismatches = [...manifests]
	.filter(([, manifest]) => `v${manifest.version}` !== tag)
	.map(([path, manifest]) => `${path}=${manifest.version ?? "missing"}`);

if (mismatches.length > 0) {
	throw new Error(
		`origin/main does not declare ${tag}: ${mismatches.join(", ")}. ` +
			"Land the version bump on main before tagging.",
	);
}

const existing =
	await Bun.$`git ls-remote --tags origin refs/tags/${tag}`.text();
if (existing.trim().length > 0) {
	await Bun.$`git fetch origin refs/tags/${tag}:refs/tags/${tag}`;
	const taggedManifests = new Map<string, PackageManifest>();
	for (const path of RELEASE_MANIFESTS) {
		taggedManifests.set(path, await Bun.$`git show ${tag}:${path}`.json());
	}
	const taggedMismatches = [...taggedManifests]
		.filter(([, manifest]) => `v${manifest.version}` !== tag)
		.map(([path, manifest]) => `${path}=${manifest.version ?? "missing"}`);
	if (taggedMismatches.length > 0) {
		throw new Error(
			`Existing tag ${tag} has mismatched manifests: ${taggedMismatches.join(", ")}. ` +
				"Repair the tag before publishing the release.",
		);
	}
	await Bun.$`git merge-base --is-ancestor ${tag} origin/main`;
	console.log(`Tag ${tag} already exists on origin; nothing to do.`);
	process.exit(0);
}

await Bun.$`git tag --annotate ${tag} ${target} --message ${tag}`;
await Bun.$`git push origin refs/tags/${tag}`;

console.log(`Tag created: ${tag}`);
