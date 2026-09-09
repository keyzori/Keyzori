# Developing Keyzori

```powershell
Copy-Item .env.example .env
bun run setup
bun run dev
```

The root `.env` configures the server, PostgreSQL, and Redis.

## Root development commands

```powershell
bun run dev                 # API watch mode
bun run dev:server          # equivalent focused server command
bun run dev:server:binary   # rebuild and run the standalone executable
bun run cli:help            # CLI usage
bun run cli -- customers list # invoke a CLI command
bun run test:server         # focused server tests
bun run test:cli            # focused CLI tests
```

Turborepo executes each task inside its owning app and caches successful build and type-check results.

## Repository layout

```text
apps/
  server/   HTTP API, CLI, migrations, and unified image
wiki/       working copy of the GitHub wiki (separate repo, git-ignored)
tests/      repository-level release tests
```

## Schema changes

1. Edit `apps/server/src/db/schema.ts`.
2. Run `bun run db:generate`.
3. Review and commit the generated SQL and snapshot under `apps/server/drizzle/`.
4. Run `bun run db:migrate` against a development database.

Use `db:push` only for disposable local prototyping.

## Verification

```powershell
bun run check
bun run build
bun run docker:build
```

The private `keyzori/typescript-sdk` repository owns the in-memory product-flow and opt-in live PostgreSQL/Redis compatibility tests.

`bun run build:server` creates one platform-specific `keyzori` executable plus migrations under `apps/server/dist/`. Use `keyzori serve`, `keyzori admin ...`, or `keyzori healthcheck`. The Docker build copies only these runtime artifacts into the final image.

Keep domain and application code independent of Drizzle, Redis, Elysia, and Commander. External-system implementations belong in infrastructure or delivery code.
