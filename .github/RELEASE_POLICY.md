# Releases

Keyzori v3 is beta. `package.json` supplies the server version; Release Please updates the matching Compose, example environment and developer-guide versions. Distribution consists of TypeScript source and a non-root Bun container. Nothing publishes to npm, and no application executables are built or attached.

Server and CodeQL checks run on `main`, `v3` and pull requests. Server CI validates workflows and runs pinned-runtime types/lint/schema/tests, API-reference generation and source/container/Compose smoke checks on Linux AMD64 and ARM64. These are required checks, not a claim that another platform was tested.

Release Please runs only for a successful `main` commit after both Server and CodeQL pass for that exact commit. It creates a draft release from the conventional release pull request. The publication workflow verifies immutable commit identity and main ancestry before building or using publishing credentials. `v3` pushes cannot enter this publishing path.

The draft receives `openapi.json`, LICENSE and SHA256SUMS. Linux images run the same source through the exact pinned Bun runtime and production dependency lock. Each native architecture image passes container and Compose checks before it is pushed. Its SPDX SBOM inventories that tested image, including installed third-party packages and available licence metadata. Digest-linked SBOM and SLSA-format provenance attestations identify the actual checked-out source commit, runtime pin, lockfile and Dockerfile; the provenance does not claim a SLSA certification level. The workflow retains both evidence files and attaches attestations to each native image digest. Version tags are assembled from those tested digests and inspected for both architectures. The final release job rechecks the tag and expected nonempty assets before publishing.

Only immutable version tags are produced. Automatic `latest` image/release promotion is disabled, so recovering an older draft cannot move a latest pointer backward. Operators should use a specific version or digest. Published immutable releases and tags are not rewritten.

Configure `RELEASE_TOKEN` with Contents, Issues and Pull requests write access for release pull requests. To recover a failed draft, explicitly run Release Please on `main` with its existing `release-tag`. Before running tagged code, the workflow checks its version and [publication contract](release-contract.json), then rechecks the exact commit and successful checks. Incompatible pre-v3 or binary-era drafts are rejected; recovery never invokes legacy build scripts. Compatible drafts regenerate reference assets, rebuild/test images and complete publication. A published release requires a new version for fixes.

A pushed commit is not a deployment, release, or approval to discard beta data. Serving refuses incompatible history; the deployment must explicitly run its matching migration job. Keep database backups and webhook encryption keys together.
