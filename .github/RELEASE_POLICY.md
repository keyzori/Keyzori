# Release and compatibility policy

Keyzori follows Semantic Versioning.

## Compatibility

- Pre-release versions target the latest canonical API and may make clean breaking changes without compatibility aliases.
- The server and operator CLI are one `keyzori` executable. Use the CLI from the same image as the running server.
- Database migrations are forward-only. A downgrade that crosses a migration requires restoring the pre-deployment backup.

## Support

The latest stable release receives security and correctness fixes. Pre-release versions may change without backward compatibility.

## Release artifacts

A stable release requires:

1. reviewed release notes and a version;
2. successful quality, type, test, and build/package CI jobs;
3. the live PostgreSQL/Redis container smoke test;
4. a versioned GHCR image tied to the source tag;
5. a tested backup, migration, health-check, and rollback plan for the target deployment.

## Publishing

Release Please maintains a release pull request from conventional commits. Merge that pull request when its generated changelog and version are ready. The merge creates the immutable `vX.Y.Z` tag and GitHub Release first, then builds, smoke-tests, and publishes `ghcr.io/keyzori/server`.

Every successful `main` release workflow updates `canary`. Stable releases also publish `latest`, `X.Y.Z`, and `vX.Y.Z`. Re-run a failed release run to repair missing image tags.

Store a fine-grained token with Contents, Issues, and Pull requests read/write access in the `RELEASE_TOKEN` Actions secret so Release Please can open release PRs and trigger their CI checks.

Security fixes follow [SECURITY.md](../SECURITY.md).
