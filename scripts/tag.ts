/**
 * Creates and pushes an annotated release tag on the tip of `main`.
 *
 *   bun run scripts/tag.ts v0.5.0        # tag an explicit version
 *   bun run scripts/tag.ts --from-manifest   # tag whatever origin/main declares
 *
 * Every manifest on `origin/main` is checked against the tag first, so a tag
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

await Bun.$`git fetch --force origin main "refs/tags/*:refs/tags/*"`;

const manifests = new Map<string, PackageManifest>();
for (const path of RELEASE_MANIFESTS) {
	manifests.set(path, await Bun.$`git show origin/main:${path}`.json());
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
	console.log(`Tag ${tag} already exists on origin; nothing to do.`);
	process.exit(0);
}

await Bun.$`git tag --annotate ${tag} origin/main --message ${tag}`;
await Bun.$`git push origin refs/tags/${tag}`;

console.log(`Tag created: ${tag}`);
