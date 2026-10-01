# Repository Guidelines

## Project Structure & Module Organization

Keyzori is a Bun/TypeScript licensing server built with Elysia, PostgreSQL and Redis. `src/main.ts` handles commands and startup; `src/app.ts` composes HTTP routes. Shared infrastructure lives in `src/core/`, feature modules in `src/plugins/`, and shared types in `src/types/`. Keep feature routes, models and services together.

Tests live in `src/tests/{unit,http,integration}`, with shared helpers in `src/tests/fixtures/`. Build and verification tools live in `src/scripts/`. Database migrations belong in `src/core/database/migrations/`. Active workflows and repository assets live in `.github/`; `--github/` is archived reference material. Generated binaries and OpenAPI output go to `dist/server/`.

## Build, Test, and Development Commands

Use Bun 1.4.2 and `bunx --bun`, not npm or npx.

- `bun install --frozen-lockfile`: install locked dependencies.
- `bun run dev`: run source with automatic restarts; `bun run start` runs once.
- `bun run check`: check types, formatting, migrations and the full test suite.
- `bun run test`: run tests with temporary PostgreSQL/Redis containers; Docker must be running.
- `bun run test:unit`: run tests without external services.
- `bun run format`: apply Biome formatting and fixes.
- `bun run build linux-arm64`: build an ARM64 binary and OpenAPI reference; the default target is Linux x64.
- `bun run build:verify`: build all supported targets and check for leaked build settings.

## Coding Style & Naming Conventions

Use tabs, double quotes and extensionless TypeScript imports. Biome enforces formatting and lint rules. Use PascalCase for classes and their files, camelCase for functions and variables, and existing feature folder conventions. Prefer small services with explicit dependencies. Keep runtime configuration separate from build-time capture.

## Testing Guidelines

Use Bun's test runner and `*.test.ts` filenames. Add regression tests for behaviour changes. Run subsets with `bun run test ./src/tests/http`. No numeric coverage threshold is configured. Runtime packaging changes also require container and Compose smoke checks.

## Commit & Pull Request Guidelines

Use Conventional Commits, such as `fix: correct usage reset`; history includes `chore(main): release ...`. Husky runs commitlint. PRs should explain the change, report verification, update relevant documentation, and identify migration or compatibility effects. Release Please manages changelogs and releases.

## Security & Configuration

Copy `.env.example` to `.env` and generate credentials with `bun run master-key`. Never commit secrets or production data. Generate and check migrations with `bun run db:generate` and `bun run db:check`; never edit applied migrations. Follow `SECURITY.md` for private vulnerability reports.
