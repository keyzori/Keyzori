# Repository Guidelines

Keyzori is an internal licence-key management API for developers. It uses Bun, Elysia 2 beta, Drizzle, PostgreSQL and Redis. Groups organise keys; they are not application feature entitlements. Do not add a Keyzori dashboard.

## Structure

`src/main.ts` owns commands, `src/app.ts` composes HTTP/WebSocket routes, `src/core/` owns infrastructure, and `src/plugins/` keeps feature routes, models and services together. Shared types live in `src/types/`. Tests live in `src/tests/{unit,http,integration}` with disposable fixtures in `src/tests/fixtures/`. Drizzle schema and immutable SQL migrations live in `src/core/database/`. Tooling lives in `src/scripts/`; generated API reference output goes to `dist/server/`.

## Commands

Use the Bun canary pinned by `.bun-version` and `.bun-revision`, and `bunx --bun` instead of npm/npx. See [CONTRIBUTING.md](CONTRIBUTING.md).

- `bun install --frozen-lockfile`: install locked dependencies.
- `bun doctor`: verify the selected runtime and manifest pins without changing them.
- `bun run dev` / `bun run start`: run TypeScript source.
- `bun check --types`: type checking only; no external services.
- `bun lint`: Bun's native linter; warnings fail the project check.
- `bun fmt <paths>` / `bun run format:check`: Bun's native formatter, writing scoped files or checking without writes.
- `bun run test:unit`: tests without PostgreSQL/Redis.
- `bun run test <paths>`: tests with per-run disposable PostgreSQL/Redis containers.
- `bun run db:generate`: generate Drizzle migrations.
- `bun run db:check`: compare committed SQL against freshly generated schema in disposable databases; requires Docker.
- `bun run db:migrate`: explicitly apply immutable migrations using the migrator credential.
- `bun run openapi`: generate the API reference without connecting runtime services.
- `bun check`: pinned-runtime check, types, native lint/format checks, database schema verification and the full test suite.
- `bun run smoke:source`, `bun run smoke:container`, `bun run smoke:compose`: disposable runtime checks; require Docker.

Follow the user's active validation limits. Do not treat Docker availability as permission to run a held check. Runtime packaging changes need container/Compose checks before claiming them verified. There is no compiled application distribution requirement.

## Code and data

Use tabs, double quotes and extensionless TypeScript imports. Keep small services with explicit dependencies and runtime-validated public schemas. Preserve exact PostgreSQL arithmetic, transactional audit/event/usage writes, retry idempotency, credential secrecy, trusted-proxy rules and fail-closed authorization.

Configure native lint/format behavior in `bunfig.toml`; formatting also reads `.editorconfig`. Formatting does not apply lint fixes. Use `bun lint --fix <paths>` separately when needed, and review its changes. Keep generated migration assets excluded from formatting.

New API keys start with no grants. Enforce action and group authority at each service operation and in SQL reads; use current transactional authorization. The environment master key must never appear in resources or responses. Validation does not consume counters.

Serving checks schema history and never runs migrations, resets or repairs data. Do not edit applied migrations. Never discard persistent data to hide corruption. Tests must use disposable data.

## Delivery

Use Conventional Commits; Husky runs commitlint. Stage only task changes after reviewing status and the diff. Release Please targets `main`; `v3` pushes run checks only. A commit or push is not a deployment or release.

Update affected types, examples and developer documentation alongside API changes. Record breaking behavior in the changelog; do not add compatibility layers or migration guides for the beta redesign. Never commit secrets or local configuration. Follow [SECURITY.md](SECURITY.md) for private vulnerability reports.
