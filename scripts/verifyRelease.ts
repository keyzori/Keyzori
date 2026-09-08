/**
 * Asserts that the workspace agrees on one Apache-2.0 release version, and
 * optionally that it matches the tag being released.
 *
 *   bun run scripts/verifyRelease.ts
 *   bun run scripts/verifyRelease.ts v0.5.0
 */

import {
	RELEASE_MANIFESTS,
	SEMVER_PATTERN,
	readManifest,
} from "./releaseManifests.ts";

const packages = await Promise.all(RELEASE_MANIFESTS.map(readManifest));
const versions = packages.map((manifest) => manifest.version);
const version = versions[0];

if (!version || !SEMVER_PATTERN.test(version)) {
	throw new Error("The release version must be valid SemVer.");
}
if (versions.some((candidate) => candidate !== version)) {
	throw new Error(
		`Workspace versions must match: ${RELEASE_MANIFESTS.map((path, index) => `${path}=${versions[index] ?? "missing"}`).join(", ")}`,
	);
}
if (packages.some((manifest) => manifest.license !== "Apache-2.0")) {
	throw new Error("Every workspace package must declare Apache-2.0.");
}

const requestedTag =
	process.argv[2] ??
	(Bun.env.GITHUB_REF_TYPE === "tag" ? Bun.env.GITHUB_REF_NAME : undefined);
if (requestedTag && requestedTag !== `v${version}`) {
	throw new Error(
		`Release tag ${requestedTag} does not match v${version}. ` +
			`Run \`bun run release ${requestedTag}\` so the version bump lands before the tag.`,
	);
}

console.log(`Release metadata is aligned at v${version}.`);
