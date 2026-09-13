# AGENTS.md

These instructions apply to the entire repository. Keep responses minimal.

## Project

Keyzori is one root Bun/TypeScript application:

- `src/<feature>`: customers, licenses, access, sessions, meters, activity; routes, ArkType schemas, service and repository classes, Drizzle tables.
- `src/application`: composition, HTTP, lifecycle; `src/database`: Bun SQL, relations, migrations.
- `src/cli`: class-based commands using one HTTP admin client.
- `plugins/<name>`: independently configured plugins with their own dependencies, tables, migrations, workers, and optional CLI commands.
- `tests`: service, HTTP, plugin, CLI, and real PostgreSQL/Redis tests.
- Server and SDK prose documentation lives in the separate [wiki repository](https://github.com/keyzori/keyzori/wiki). Keep SDK package READMEs brief and link to these shared guides.

The TypeScript SDK lives in `../ts-sdk`; public HTTP types live in `../types` and ship as `@keyzori/types`. Server typechecking verifies every shared type against its ArkType schema. Read README.md, CONTRIBUTING.md, and the Architecture wiki before broad changes.

## Working rules

- Use Bun 1.3.14+, bunx --bun, and bun:test. Do not introduce npm, pnpm, yarn, Turbo, ESLint, or Prettier workflows.
- Run TypeScript directly with Bun. Do not compile, transpile, bundle, or generate dist artifacts. Docker installs dependencies and copies source once.
- Preserve unrelated changes. Keep public HTTP, CLI, configuration, database, and documentation contracts synchronized.
- Whenever an endpoint changes, update the shared public typings and TypeScript SDK requests, responses, runtime validation, and contract tests in the same change. Cover paths, methods, authentication, errors, pagination, and JSON wire types (including serialized dates). Run contract checks against the modified server; never leave SDK typings behind or silently skip compatibility checks.
- Use small classes and constructor injection. Keep Elysia handlers thin and inferred, ArkType schemas and Drizzle tables declarative. Avoid controller inheritance, generic repositories, DI frameworks, duplicate interfaces, and unnecessary wrappers.
- Keep authored files below 500 lines; generated artifacts are exempt.
- Keep all plugin-specific imports, configuration, tables, migrations, and workers out of core. Plugin Elysia instances declare their own /plugins/<name> constructor prefix; the loader never rewrites routes.
- Licensing, authentication, sessions, metering, billing, and migrations are security-sensitive. Do not weaken validation, binding, revisions, locks, idempotency, redaction, or transaction guarantees without explicit approval.
- Add behavioral tests and regression coverage for fixes.
- Generate migrations with bun run db:generate and review the generated SQL. Do not use db:push. Never erase an existing database to make startup succeed.
- Server startup applies core and enabled-plugin migrations under the database lock before opening HTTP or starting workers. Missing or modified migration history and migration failures must prevent startup. The standalone migrate command remains available; Compose runs migrations within the server container.
- Never commit secrets, license keys, credentials, customer data, or production logs.

## Style and validation

Use strict TypeScript, tabs, double quotes, and Biome. Run the narrowest relevant checks first, then bun run check. Real infrastructure tests require KEYZORI_TEST_DATABASE_URL and KEYZORI_TEST_REDIS_URL. Run Docker smoke tests for distribution changes and report unrun checks accurately.

Before completion, review git diff and git status. Report behavior changes, verification, and remaining limitations. Do not commit, push, publish, deploy, migrate a live database, or contact external services unless explicitly requested. Local isolated verification is allowed when implementing an authorized change.
