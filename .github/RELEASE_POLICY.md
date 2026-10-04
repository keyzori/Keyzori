# Releases

The rewrite starts at **v2.0.0** with a fresh changelog. `package.json` is the version source for the server and its binaries. The empty release manifest and `initial-version` setting start the new release history; later releases follow conventional commits automatically.

Stable v2 releases support Linux x64 and ARM64. Windows binaries remain experimental because Bun 1.4.2 has crashed during PostgreSQL outage testing and graceful shutdown is unverified. macOS binaries receive native build/version checks only; runtime behaviour is untested. Elysia 2 beta remains a pinned dependency. These limitations must appear in the first v2 release notes. V1 APIs, settings and databases are incompatible; back up the old deployment and use a separate fresh database for v2. There is no supported in-place v1 upgrade. The console and installable plugins are not part of v2.

Release Please targets only `main` and runs after successful Server and CodeQL checks for the same commit. Integrating `v2` into `main` updates the existing main release PR to 2.0.0; it does not itself publish a release. Server checks include actionlint validation of the active workflows. Merging the release PR creates the tag and GitHub release, then builds Linux x64/ARM64, macOS x64/ARM64 and Windows x64 binaries from that exact commit. Every binary gets a native version check; Linux also gets full runtime smoke tests. Releases include `.tar.gz` archives (Linux/macOS), a `.zip` archive (Windows), `openapi.json` and `SHA256SUMS`.

After uploading the assets, the workflow publishes Linux AMD64/ARM64 images to `ghcr.io/<owner>/server` with the release tag, version without `v`, and `latest` for stable releases. This matches the image used by Compose. The image contains the compiled server in a non-root distroless runtime; source, dependencies and build tools remain in the build stage. Development runs from TypeScript source. Nothing publishes to npm.

Each architecture is built once on a native runner, passes container and Compose smoke tests, and is pushed under a unique build tag. Release tags are created from those exact digests only after both architectures pass. Third-party workflow actions are pinned to commit SHAs.

Publication then reads every release image tag back from GHCR, requires both Linux architectures, and verifies that all tags resolve to the same image index. The `published-server-images` workflow artifact records the inspected manifests and tag digests so publication can be verified without adding package credentials to an operator's laptop.

Configure `RELEASE_TOKEN` with repository Contents, Issues and Pull requests write access so release PRs can trigger CI. The `v2` branch runs checks without publishing releases. The first changelog includes changes after the final v1 release commit.

If a build, upload or image publication fails, run Release Please manually on `main` with the existing `release-tag`. It verifies successful Server and CodeQL checks for the tagged commit, rebuilds the binaries, replaces release assets and republishes tested images. This also works after CI artifacts expire.
