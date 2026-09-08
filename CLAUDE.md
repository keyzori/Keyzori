# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` holds the authoritative working rules (Bun-only toolchain, layer boundaries, security-sensitive areas, style, handoff expectations). Read it. This file covers commands and the architecture those rules protect.

Never `git commit` or `git push` unless the human explicitly asks for it in that request — this applies in every context, including the `Claude Code` GitHub Action running in CI/PRs. Diagnosing and fixing an issue does not imply permission to commit the fix; propose the diff (or leave it uncommitted in the working tree / PR comment) and wait for explicit go-ahead.

## Commands

Bun 1.3.14+, Turborepo. Never introduce npm/pnpm/yarn, ESLint, or Prettier.

```bash
bun run dev              # watch-mode API (turbo --filter=keyzori-server)
bun run cli -- customers list   # invoke the admin CLI; note the `--`
bun run typecheck        # all workspaces + tests/tsconfig.json
bun run test             # bun test apps tests
bun run lint             # biome check .
bun run build            # compiled `keyzori` executable + SDK dist
bun run check            # release gate: typecheck, test, coverage, release:verify, lint
```

Scoped checks — prefer these while iterating, then widen:

```bash
bun run check:server     # server typecheck + tests
bun run check:cli
bun run check:sdk
bun run test:flow        # tests/productFlow.test.ts, in-memory cross-app lifecycle
bun run test:sdk:compiled
```

Single test file or filtered case:

```bash
bun test apps/server/src/test/LicenseService.test.ts
bun test apps/server/src/test/LicenseService.test.ts --test-name-pattern "usage"
```

`test:coverage:core` enforces an 80% line threshold on the three application services and the SDK; CI runs it via `bun run check`, so keep new service/SDK code covered.

### Database

Schema lives in `apps/server/src/db/schema.ts`. Edit it, then:

```bash
bun run db:generate      # writes apps/server/drizzle/<timestamp>_<name>/{migration.sql,snapshot.json}
bun run db:check         # validates migration history (CI runs this)
bun run db:migrate
```

Commit the generated SQL *and* snapshot alongside the schema change. `db:push` is for disposable local prototyping only.

### Releases

Releases are automated; never bump a version or move a tag by hand. A release is
declared by landing a commit on `dev` whose message carries a release directive:

```bash
git commit --allow-empty -m "release: patch"
```

`patch`, `minor`, `major`, and explicit `release: v1.2.0` are all accepted, and the
directive may be embedded in a PR title as `[release: minor]`. `.github/workflows/promote.yml`
then runs `scripts/release.ts`, which syncs every manifest, runs `bun run check`,
commits `chore(release): vX.Y.Z` to `dev`, and opens an auto-merging `dev -> main`
pull request. When that lands, `.github/workflows/tag.yml` tags whatever version
`main` declares, and the tag triggers `release.yml`.

The invariant the pipeline exists to protect: **the tag never leads the version**.
`scripts/tag.ts` reads all three manifests from `origin/main` and refuses to tag a
commit that does not already declare that version — the failure mode that broke
v0.4.2, where the tag was cut on a commit still declaring 0.4.1.

```bash
bun run release patch --dry-run   # print every git/gh action, change nothing
bun run release:sync 0.5.0        # rewrite the three manifests only
bun run release:tag --from-manifest   # idempotent; no-op if the tag exists
```

Both workflows authenticate as a GitHub App, because the `Protect main` and
`Protect release tags` rulesets restrict pushes and `v*` tag creation to actors on
their bypass lists. The app needs `contents: write` and `pull_requests: write`, and
must be added to both rulesets' bypass actors; its credentials live in the
`RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` secrets.

### Opt-in / external-dependency checks

`bun run test` uses in-memory and fake adapters exclusively — no PostgreSQL, Redis, Docker, or Stripe needed. These need real services and are excluded from the default suite; say explicitly when you did not run them:

```bash
bun run test:live        # requires KEYZORI_LIVE_TEST_ENABLED=true + disposable PG/Redis URLs
bun run docker:build
```

## Architecture

Monorepo: `apps/server` (API + CLI + migrations), `apps/sdk` (publishable `keyzori` npm package), `tests` (cross-app + compiled-artifact), `docs`. `apps/dash` is an empty placeholder — the embedded dashboard was removed (commit `6396418`), so `KEYZORI_DISABLE_DASHBOARD` and `/dashboard/*` no longer exist anywhere; `/` is expected to 404.

### One binary, three entrypoints

`apps/server/src/main.ts` dispatches on `process.argv[2]`: `serve` → `startServer()`, `admin` → the Commander program, `healthcheck` → HTTP probe of `/ready`. `bun run build` compiles this single file to `apps/server/dist/keyzori` (minified + bytecode) and copies `drizzle/` next to it; the Docker image contains only those artifacts — no Bun, no `node_modules`.

### Layers (do not cross)

- `src/domain/` — entities, `ApiErrorCode`/`DomainError` hierarchy, repository *interfaces* (`I*Repository`). No Drizzle, Redis, Elysia, or Commander imports.
- `src/application/services/` — `LicenseService` (runtime: activate/heartbeat/usage/deactivate), `AdminService` (operator surface, ~1100 lines), `ActivityService` (telemetry + retention pruning). Depend only on domain interfaces.
- `src/infrastructure/repositories/` — `Drizzle*` for PostgreSQL, `RedisSessionRepository` for sessions/concurrency.
- `src/controllers/` — Elysia plugins: `licensePlugin` (public `/v1/*`), `adminPlugin` (`/admin/*`, `X-Admin-Key`), plus `validation.ts` schemas and `clientIp.ts` proxy-header resolution.
- `src/composition/services.ts` — the only place the graph is wired. `createServiceGraph(sessionRepository, database, retentionDays)` is used by both the server and, via `createConnectedAdminService`, the CLI.

`src/index.ts` assembles the runtime: OpenAPI/Scalar at `/docs`, global `onError` mapping `DomainError` → status+code, security headers, `/health`, `/ready`, rate limiting, license plugin, optional Stripe, then admin plugin. Because tests inject `redis`/`config`/`database` into `createServer`, keep new dependencies injectable the same way.

### Invariants worth knowing before editing

- **Secret is used once.** `POST /v1/activate` takes the `lic_...` key; heartbeat/usage/deactivate use an opaque Redis session token bound to activation IP + `deviceId`. Keys are stored hashed (`hashLicenseKey`); only `keyPrefix` is ever returned after creation/rotation. Legacy `sk_` hashes remain valid.
- **Idempotent metering.** `POST /v1/usage` debit + ledger insert are one transaction under a unique `(licenseId, eventId)`; retries replay, mismatched replays return `USAGE_EVENT_CONFLICT`. The ledger stores only the SHA-256 of `eventId`.
- **Serialized registration.** Device/IP slot claims use a per-license advisory lock; session admission/refresh use Redis scripts. Both exist so concurrent activations cannot overrun `maxIps`/`maxDevices`/`maxSessions` (`0` = unlimited).
- **Four license types** (`lifetime`, `subscription`, `metered`, `trial`) share one row. A type change preserves the secret, customer, limits, allowlists, and registrations, and parks the old type's settings in `typeDrafts`. Trial start is a compare-and-set on first activation.
- **Allowlists flip semantics on first entry**: empty = allow any (subject to the max), non-empty = allow only listed.
- **Stripe is fully optional** and only mounts when *both* `KEYZORI_STRIPE_SECRET_KEY` and `KEYZORI_STRIPE_WEBHOOK_SECRET` are set (`config.ts` rejects one-without-the-other). Webhooks are verified, durably queued, deduplicated by event ID, and processed by `StripeWebhookWorker`, which re-reads current subscription state — so out-of-order delivery is safe. Manual and billing revocations are independent fields.
- **Activity payloads redact.** General activity/statistics responses must not carry full secrets, raw IPs, or raw device IDs; exact identifiers appear only in the authenticated per-license access view.
- **Config is validated, not defaulted.** `loadServerConfig` throws on placeholder or short admin keys, bad URLs/protocols, out-of-range integers, and invalid proxy CIDRs. Add new settings there with the same explicit bounds.

### Contract surfaces to keep in sync

A behavior change usually touches several of: `controllers/validation.ts`, the SDK (`apps/sdk/src/core/`), CLI commands (`src/cli/commands/`), the wiki pages `API-Reference`, `CLI-Reference`, `SDK-Reference`, `Configuration` (see `Wiki` below), `.env.example`, and `apps/server/.env.example`.

Versions in the root, server, and SDK `package.json` must match and all declare Apache-2.0 — `scripts/verifyRelease.ts` (`bun run release:verify`) enforces this.

### Wiki

Prose documentation lives in the GitHub wiki (<https://github.com/lilsnibbi/Keyzori/wiki>), not in this repository. The wiki is its own git repository:

```bash
git clone https://github.com/lilsnibbi/Keyzori.wiki.git
```

Page files are flat and named after the page (`API-Reference.md` renders as "API Reference" at `/wiki/API-Reference`); `Home.md` is the entry point and `_Footer.md` the shared footer; GitHub renders its own page index, so do not add a `_Sidebar.md`. Links between pages use the bare page name (`[Deployment](Deployment)`); links back into this repository must be absolute URLs. Images stay in `.github/assets/` here and are referenced from the wiki by raw URL. A documentation change ships as a wiki commit, separate from the code commit.

### Test conventions

`bun:test` throughout. Server unit tests hand-roll fakes (`FakeQuery` chainables for Drizzle, `mock()` for services); `tests/productFlow.test.ts` implements the full set of `I*Repository` interfaces in memory and drives the real `LicenseService`/`AdminService`/`licensePlugin`. When you add a repository method, that in-memory implementation needs it too.
