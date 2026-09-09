# AGENTS.md

These instructions apply to the entire repository.

## Project

Keyzori is a self-hosted software-license manager built with Bun and TypeScript:

- `apps/server`: Elysia API, CLI, PostgreSQL, Redis, and Stripe integration.
- `tests`: repository-level release tests.
- The TypeScript SDK and its compatibility tests live in the private `keyzori/typescript-sdk` repository.
- `.github/assets`: README and wiki image assets. Prose documentation lives in the [GitHub wiki](https://github.com/lilsnibbi/Keyzori/wiki).

Read `README.md`, `CONTRIBUTING.md`, and the [Architecture wiki page](https://github.com/lilsnibbi/Keyzori/wiki/Architecture) before making broad or architectural changes.

## Working rules

- Use Bun 1.3.14 or newer. Use `bun`, `bunx`, and `bun:test`; do not introduce npm, pnpm, yarn, ESLint, or Prettier workflows.
- Preserve existing user changes. Keep edits focused and do not revert unrelated work.
- Respect the domain, application, infrastructure, and controller layer boundaries described in the [Architecture wiki page](https://github.com/lilsnibbi/Keyzori/wiki/Architecture).
- Keep public HTTP, CLI, configuration, database, and documentation contracts synchronized. Runtime endpoint changes must also update and pass the separate TypeScript SDK contract suite.
- Add or update tests for behavior changes. Include regression tests for bug fixes.
- Treat licensing, authentication, session, metering, Stripe, and migration changes as security-sensitive.
- Never commit secrets, license keys, credentials, customer data, or production logs.
- Do not weaken validation, token binding, concurrency controls, idempotency, secret redaction, or transactional guarantees without explicit approval.
- Generate schema migrations with `bun run db:generate`; review generated SQL and commit the migration with its schema change.
- Avoid `db:push` for committed development or production migrations.
- Update relevant documentation and examples when user-visible behavior changes; prose documentation lives in the separate [wiki repository](https://github.com/lilsnibbi/Keyzori/wiki), so it ships as its own commit.

## Style

- Follow strict TypeScript and existing naming patterns.
- Use tabs and double quotes as configured by Biome.
- Prefer small, explicit modules and typed boundaries.
- Avoid new dependencies when the platform or an existing dependency already provides the capability.
- Do not manually reorganize unrelated imports or reformat unrelated files.

## Validation

Run the narrowest relevant checks first, then broaden them according to risk:

```powershell
bun run typecheck
bun run test
bun run lint
bun run build
```

Useful scoped commands include:

```powershell
bun run check:server
bun run check:cli
bun run db:check
```

Use `bun run check` for release-level verification. Live tests, Docker builds, PostgreSQL, Redis, and Stripe checks require their external dependencies; report clearly when they were not run.

## Completion

Before handing off work:

- Review `git diff` and `git status` for unintended changes.
- Report changed behavior, validation performed, and any remaining risks or unrun checks.
- Do not commit, push, publish, deploy, migrate a live database, or contact external services unless explicitly requested.
