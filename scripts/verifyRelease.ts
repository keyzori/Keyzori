/** Verifies the root release metadata and an optional release tag. */

import { resolve } from "node:path";

const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const manifest = (await Bun.file(
	resolve(import.meta.dir, "../package.json"),
).json()) as { license?: unknown; version?: unknown };
const version = manifest.version;

if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
	throw new Error("The release version must be valid SemVer.");
}
if (manifest.license !== "Apache-2.0") {
	throw new Error("The root package must declare Apache-2.0.");
}

const requestedTag =
	process.argv[2] ??
	(Bun.env.GITHUB_REF_TYPE === "tag" ? Bun.env.GITHUB_REF_NAME : undefined);
if (requestedTag && requestedTag !== `v${version}`) {
	throw new Error(
		`Release tag ${requestedTag} does not match v${version}. ` +
			"Merge the Release Please pull request before creating the tag.",
	);
}

console.log(`Release metadata is aligned at v${version}.`);
