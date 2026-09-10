# Keyzori

A self-hosted licensing API and operator CLI, running as one Bun application.

This rebuild replaces the previous HTTP API, configuration, database, and migrations. **Use a fresh PostgreSQL database.** Startup refuses existing legacy data and never erases it. The separate TypeScript SDK is outside this rebuild.

## Setup

Requires Bun 1.3.14+, PostgreSQL, and Redis.

```powershell
Copy-Item .env.example .env
# Configure dependency URLs and a random KEYZORI_ADMIN_KEY (32+ characters).
bun run setup
bun run db:migrate
bun run start
```

Setup installs locked core and plugin dependencies. The one-shot `migrate` command locks PostgreSQL, applies core then enabled-plugin migrations, and exits. It does not connect to Redis or start HTTP/workers. Server startup validates plugins and verifies migration names/hashes; pending migrations prevent it from listening.

- `/health`: liveness; `/ready`: PostgreSQL/Redis readiness.
- `/docs`: interactive API reference; `/openapi.json`: generated schema.
- `/admin/*`: administration using `X-Admin-Key`.
- `POST /sessions`: activate with `{ "key": "lic_…", "deviceId": "your-device" }`.
- `POST /sessions/heartbeat`, `/sessions/deactivate`, and `/usage`: bearer session token plus `X-Device-Id`.

License keys are hashed; plaintext is returned only on creation or rotation. Sessions are bound to license, device, IP, and policy revision, with a default 60-second TTL. Policy changes require a new activation.

## License types

| Type | Configuration |
| --- | --- |
| `lifetime` | No type expiry |
| `subscription` | Future ISO `expiresAt`; renewable |
| `metered` | Named integer meters and idempotent usage events |
| `trial` | `durationSeconds`, starting on first successful activation |

All types support customers, metadata, source-specific blocks, registered device/IP limits, separate allowlists, and concurrent session limits. Activity is redacted and retained for 30 days by default.

## CLI

The CLI uses only `KEYZORI_URL` and `KEYZORI_ADMIN_KEY`; plugin commands also use `KEYZORI_PLUGINS`. JSON arguments accept `@file.json`.

```powershell
bun run cli -- --help
bun run cli -- customers create '{"email":"owner@example.com","name":"Owner"}'
bun run cli -- licenses create @license.json
bun run cli -- licenses list
bun run cli -- access get <license-id>
bun run cli -- sessions terminate <license-id>
```

## Plugins

Root `plugins/<name>/index.ts` entries are discovered automatically. Enable names with comma-separated `KEYZORI_PLUGINS`; the default is none. Loading is alphabetical. Plugins own their dependencies, configuration, tables, migrations, workers, and CLI extensions.

Stripe is an ordinary plugin. See [its setup instructions](plugins/stripe/README.md). Plugin development and API details are in the [wiki](https://github.com/keyzori/keyzori/wiki).

## Verification and Docker

```powershell
bun run check
# Docker provisions isolated PostgreSQL/Redis, runs all tests with coverage, and cleans up.
bun run test:local
# Or point the suite at existing isolated local services:
$env:KEYZORI_TEST_DATABASE_URL = "postgresql://postgres:test-password@127.0.0.1:5432/postgres"
$env:KEYZORI_TEST_REDIS_URL = "redis://127.0.0.1:6379"
bun run test:integration
bun run docker:build
bun run docker:smoke
```

Integration tests create and drop uniquely named test databases. Without both test URLs, infrastructure suites explicitly skip. Use isolated test services; no real Stripe account is required.

Bun runs the TypeScript source directly: `bun src/main.ts serve`. There is no compilation, bundling, or `dist` output. Docker installs production dependencies and copies source once, running Bun as a non-root user.

One `compose.yml` runs PostgreSQL, Redis, migrations, and the server: `docker compose up --build -d`. Set `KEYZORI_ADMIN_KEY` and a URL-safe `KEYZORI_POSTGRES_PASSWORD` in `.env`. Only the API is published, on localhost by default; PostgreSQL and Redis use private networking and persistent volumes. Compose supplies the internal dependency URLs. Use `KEYZORI_BIND_ADDRESS` and `KEYZORI_PORT` to change the API binding.

Compose reuses one Alpine image with production dependencies for `migrate` and `server`. The server waits for successful migrations. When upgrading or enabling plugins, run `docker compose build`, `docker compose run --rm migrate`, then `docker compose up -d`. A migration failure prevents startup; existing data is never reset. To use a published image, set `KEYZORI_IMAGE`, then run `docker compose pull server migrate` and `docker compose up --no-build -d`.

[Contributing](CONTRIBUTING.md) · [Apache-2.0 license](LICENSE)
