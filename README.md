<div align="center">

<img width="2560" height="720" alt="Keyzori banner" src=".github/assets/banner.png" />

[Documentation](src/README.md) · [Deployment](src/README.md#run)

</div>

Keyzori is an internal licence-key management service for developers. Use it for authentication-token validation, access control, usage accounting or other integrations. Groups are neutral containers for related keys. Developers build their own integrations and dashboards; Keyzori has no dashboard or application-feature entitlement system.

V3 is beta and deliberately changes the API and database format. It runs TypeScript source with Bun, Elysia 2 beta, Drizzle, PostgreSQL and Redis. Serving verifies schema history and refuses incompatible databases without changing their data.

## What it does

- Issue and rotate credentials, optionally associate keys with a group and user, and control expiry or disabled reasons.
- Validate a licence using only its key, optionally checking an expected group. Validation returns licence, group, user, metadata and usage information without consuming usage; administrative notes are excluded throughout.
- Atomically consume exact named counters with independent limits, calendar resets and durable retry deduplication.
- Restrict API keys by explicit permissions and selected groups, with a separate environment master credential.
- Expose authorised audit history, durable integration events over HTTP/WebSocket, and signed webhooks with bounded retries.

**Anyone holding a licence key can read its validation view**, including linked group/user metadata, raw hardware IDs and registered IPs. Administrative notes on the licence, group and user are excluded. Credentials and secret hashes are never returned by validation. See [validation exposure](src/README.md#validation-and-key-exposure).

## Quick start

Use the exact [Bun runtime pin](CONTRIBUTING.md), PostgreSQL 17 or later and Redis. Install dependencies, copy [`.env.example`](.env.example) to `.env`, and generate the master credential:

```sh
bun install --frozen-lockfile
bun run master-key
```

Set `KZ_MASTER_KEY`, the runtime `KZ_DATABASE_URL`, the separate `KZ_MIGRATION_DATABASE_URL`, and `KZ_REDIS_URL`. Provision database roles using the [deployment guidance](src/README.md#run), then:

```sh
bun run db:migrate
bun run start
```

`bun run dev` restarts source during development. `/health` reports readiness and dependency probe age. [Create a first licence](src/README.md#first-licence), then use the [API guide](src/README.md#responses-and-api-access). Generate `dist/server/openapi.json` with `bun run openapi`; the running server does not host the reference UI.

## Docker

Copy `.env.example` to `.env`. Set `KZ_MASTER_KEY`, `KZ_POSTGRES_PASSWORD`, `KZ_SERVER_DATABASE_PASSWORD`, and `KZ_MIGRATION_DATABASE_PASSWORD`. Generate the master with `bun run master-key`; use separate random 64-character hexadecimal values for the three database passwords.

```sh
docker compose up --build -d
```

Compose starts PostgreSQL and Redis, runs an explicit one-shot migration job, then starts the API with its restricted runtime database role. The source container runs as UID 65532 with a read-only root filesystem. PostgreSQL persists in a named volume. Only the API is published, at `http://127.0.0.1:6284`.

Set `KZ_WEBHOOK_ENCRYPTION_KEY` to a separate random 64-character hexadecimal value when using webhooks. Keep this key with database backups. Configure an HTTPS reverse proxy for remote access and trust only its actual addresses. [Environment and operations](src/README.md#environment) explains the remaining controls.

## Development

| Command                                                                      | Purpose                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `bun doctor`                                                                 | Verify the exact runtime pin.                                      |
| `bun check --types`                                                          | Check TypeScript without external services.                        |
| `bun lint` / `bun fmt <paths>`                                               | Check or format through project commands.                          |
| `bun run test:unit`                                                          | Run tests without database containers.                             |
| `bun run test <paths>`                                                       | Run focused tests with disposable PostgreSQL/Redis.                |
| `bun run db:generate` / `bun run db:check`                                   | Generate migrations or compare actual SQL with the Drizzle schema. |
| `bun check`                                                                  | Run runtime, type, lint, schema and full test checks.              |
| `bun run smoke:source` / `bun run smoke:container` / `bun run smoke:compose` | Exercise disposable deployments.                                   |

Database checks and runtime smoke checks require Docker. Follow the task's validation limits before running broad checks. [CI](.github/workflows/server.yml) targets Linux AMD64 and ARM64; a configured check is not evidence that a particular revision passed. Pushes to `v3` run CI without publishing or deploying. See [release policy](.github/RELEASE_POLICY.md).

## Documentation

- [Developer and deployment guide](src/README.md)
- [Contributing](CONTRIBUTING.md), [security](SECURITY.md), [support](SUPPORT.md), [governance](GOVERNANCE.md)
- [Changelog](CHANGELOG.md)

## License

Copyright © 2026 Keyzori contributors. Licensed under [Apache License 2.0](LICENSE).
