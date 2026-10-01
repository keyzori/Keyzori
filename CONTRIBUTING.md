# Contributing

Use Bun 1.4.2 and Docker. Server code lives in `src/`.

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
