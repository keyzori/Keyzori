# Contributing

Use the pinned Bun 1.4.4 canary and Docker. Server code lives in `src/`.

```sh
bun install --frozen-lockfile
bun run dev
bun run check
```

Set up `.env` using the [server guide](src/README.md). Development runs from TypeScript source. `bun run check` covers types, lint, migrations and tests with temporary PostgreSQL/Redis containers. `bun run test:unit` needs no services.

Use extensionless code imports, tabs, double quotes and small services with explicit dependencies. Add tests when changing behaviour. Keep API schemas and docs in sync, and never commit secrets or production data.

For database changes, run `bun run db:generate` and `bun run db:check`. Review the generated SQL; never edit an applied migration. This rewrite starts with a fresh database.

`bun run build` creates a Linux x64 binary and API reference in `dist/server/`; use `bun run build linux-arm64` for ARM64. Docker deploys the binary. `bun run build:verify` checks all supported build targets for leaked build settings. CI also checks startup, HTTPS, scheduled work, shutdown and Compose persistence.

Use conventional commit messages such as `fix: correct usage reset`. [Release Please](.github/RELEASE_POLICY.md) manages v2 releases from `main`. Report security issues privately using [SECURITY.md](SECURITY.md).

## Bun runtime

`.bun-version` pins the official npm package `bun@1.4.4-canary.20261022.1`; `.bun-revision` records its verified runtime revision, `1.4.4-canary.1+963452075`. `bun --version` only reports `1.4.4`, so use `bun --revision` to identify the canary. The GitHub `canary` release and Docker canary tags move independently; they are not interchangeable with this package.

The shared CI action installs the package into a temporary directory with `bun add --global --trust`, then verifies the revision before any project commands. The Docker build uses the same package and revision check. Both use stable Bun 1.4.4 only to bootstrap the installer. Bun types are pinned to 1.4.3, the newest published `@types/bun` package available for this update.

Update `.bun-version`, `.bun-revision` and `packageManager` together after verifying all native platforms. Runtime pins require manual review while this canary is selected. PR checks build and package all five binary targets, verify artifact downloads and prepare checksums, alongside Linux source, container and Compose checks. Windows remains experimental and macOS runtime behaviour remains untested.
