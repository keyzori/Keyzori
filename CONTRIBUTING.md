# Contributing

Use Bun 1.3.14+, TypeScript, ArkType, Drizzle, and Biome. Read [AGENTS.md](AGENTS.md) and the [Architecture wiki](https://github.com/keyzori/keyzori/wiki/Architecture).

```powershell
bun run setup
bun run typecheck
bun run test
bun run lint
bun run db:check
```

Run `bun run test:unit` for independent tests, or `bun run test:local` for the complete suite with isolated Docker PostgreSQL/Redis and coverage. The latter requires installed dependencies and Docker; it runs Bun tests on Linux and removes its containers/network afterward. Optional arguments select a suite, for example `bun run test:local tests/http`.

Alternatively, set `KEYZORI_TEST_DATABASE_URL` and `KEYZORI_TEST_REDIS_URL` to isolated local services, then run `bun run test:integration` or `bun run test:coverage`. Both require the URLs; coverage writes `coverage/lcov.info`. Tests provision uniquely named databases and clean them up. `bun run test` skips infrastructure when URLs are absent. Run `bun run docker:build` and `bun run docker:smoke` for distribution changes.

CI runs typecheck, lint, migration integrity, release metadata, unit tests, Compose validation, and five independent infrastructure suites. Only after every check succeeds does the final Docker job build an image, smoke-test it, and publish that same image. Pull requests verify without publishing. Release tags are pinned to the exact verified commit.

Keep handlers thin, schemas declarative, and service/repository classes small. Use constructor injection; avoid generic repositories and framework-dependent controller classes. Authored files must remain below 500 lines. Plugin-specific code belongs under `plugins/<name>`.

Bun runs TypeScript directly. Do not add compilation, transpilation, bundling, or a dist directory. Docker installs production dependencies and copies the source once.

Generate migrations with `bun run db:generate`; review SQL and snapshots. Never rewrite applied migration history or use `db:push`. Core and plugins have separate journals. A fresh database is required for this rebuild.

Add behavioral and regression tests. Keep API schemas, CLI commands, environment examples, and wiki documentation synchronized. The separate SDK is out of scope for this rebuild.

Do not include credentials, license keys, customer data, or production logs in commits. Report vulnerabilities according to [SECURITY.md](SECURITY.md).
