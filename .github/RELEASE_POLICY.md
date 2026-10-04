# Releases

The rewrite starts at **v2.0.0** with a fresh changelog; subsequent releases follow conventional commits automatically. `package.json` is the version source for the server and its binaries. Release Please also updates the annotated server image version in `compose.yml` and `KZ_VERSION` in `.env.example` so default deployments use the corresponding release.

The original v2.0.0 release was published before assets were uploaded. GitHub made it immutable, so it has no downloadable binaries or release image. Use a subsequent complete patch release rather than trying to change that locked release or tag.

Stable v2 releases support Linux x64 and ARM64. Windows binaries remain experimental because Bun 1.4.2 has crashed during PostgreSQL outage testing and graceful shutdown is unverified. macOS binaries receive native build/version checks only; runtime behaviour is untested. Elysia 2 beta remains a pinned dependency. These limitations must appear in the first v2 release notes. V1 APIs, settings and databases are incompatible; back up the old deployment and use a separate fresh database for v2. There is no supported in-place v1 upgrade. The console and installable plugins are not part of v2.

Release Please targets only `main` and runs after successful Server and CodeQL checks for the same commit. Server checks include actionlint validation of the active workflows. Merging the release PR creates a tag and draft GitHub release, then builds Linux x64/ARM64, macOS x64/ARM64 and Windows x64 binaries from that exact commit. Release Please creates the tag immediately with `force-tag-creation` so draft recovery and subsequent changelogs can resolve the release commit. Every binary gets a native version check; Linux also gets full runtime smoke tests. Draft releases receive `.tar.gz` archives (Linux/macOS), a `.zip` archive (Windows), `openapi.json` and `SHA256SUMS`.

After uploading the assets, the workflow publishes Linux AMD64/ARM64 images to `ghcr.io/<owner>/server` with the release tag, version without `v`, and `latest` for stable releases. This matches the image used by Compose. The image contains the compiled server in a non-root distroless runtime; source, dependencies and build tools remain in the build stage. Development runs from TypeScript source. Nothing publishes to npm.

Each architecture is built once on a native runner, passes container and Compose smoke tests, and is pushed under a unique build tag. Release tags are created from those exact digests only after both architectures pass. Third-party workflow actions are pinned to commit SHAs.

Publication then reads every release image tag back from GHCR, requires both Linux architectures, and verifies that all tags resolve to the same image index. The `published-server-images` workflow artifact records the inspected manifests and tag digests so publication can be verified without adding package credentials to an operator's laptop.

Only after binaries, asset uploads and image publication all succeed does the final job publish the GitHub release. It verifies the tag still points to the checked commit and all seven expected assets are uploaded and nonempty. GitHub can then make the complete release immutable; stable releases become the latest release.

Configure `RELEASE_TOKEN` with repository Contents, Issues and Pull requests write access so release PRs can trigger CI. The `v2` branch runs checks without publishing releases. The first changelog includes changes after the final v1 release commit.

If a build, upload or image publication fails, verify the release is still a draft, then run Release Please manually on `main` with the existing `release-tag`. It verifies successful Server and CodeQL checks for the tagged commit, rebuilds binaries, replaces draft assets, republishes tested images and completes publication. This also works after CI artifacts expire. Published immutable releases cannot receive replacement assets; fixes require a new version through a release PR. Do not disable immutability or move published tags to recover a failed release.
