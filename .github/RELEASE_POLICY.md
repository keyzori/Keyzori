# Release and compatibility policy

Keyzori follows Semantic Versioning. The server and TypeScript SDK are versioned and released independently.

## Compatibility

- Pre-release versions target the latest canonical API and may make clean breaking changes without compatibility aliases.
- Stable `keyzori` SDK releases follow Semantic Versioning.
- The server and operator CLI are one `keyzori` executable. Use the CLI from the same image as the running server.
- Database migrations are forward-only. A downgrade that crosses a migration requires restoring the pre-deployment backup.

## Support

The latest stable release receives security and correctness fixes. Pre-release versions may change without backward compatibility.

## Release artifacts

A stable release requires:

1. a reviewed changelog and version;
2. `bun install --frozen-lockfile`, `bun run check`, `bun run build`, `bun run smoke:packages`, and `bun run db:check`;
3. the live PostgreSQL/Redis flow and Docker build in CI;
4. a versioned GHCR image tied to the source tag;
5. a tested backup, migration, health-check, and rollback plan for the target deployment.

## Publishing

The repository creates a GitHub Release with generated notes and pushes the unified container to `ghcr.io/lilsnibbi/keyzori`. Every successful `main` commit updates `canary`. Releases receive only `v`-prefixed SemVer tags; stable releases also update `latest`, while prereleases never do. The private `keyzori/typescript-sdk` repository publishes the `keyzori` npm package separately.

After the version and changelog are aligned, push the matching tag (for example, `v1.0.0`). The release workflow verifies, builds, and smoke-tests the server image before publishing. To repair an existing tag, run the workflow manually and enter that tag.

Security fixes follow [SECURITY.md](../SECURITY.md).
