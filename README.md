<div align="center">

<img width="2560" height="720" alt="Keyzori banner" src=".github/assets/banner.png" />

[`📖 Documentation`](src/README.md) · [`💻 Deployment`](src/README.md#run)

<br />

</div>

> [!WARNING]
> This rewrite changes the API, settings, and database format. Start with a fresh PostgreSQL database; older databases and client integrations are not compatible. It remains a development prerelease using Elysia 2 beta.

Keyzori is a self-hosted license server for software products. Create users, items and licenses, control device and IP access, and track usage through an HTTP API.

You host the server, PostgreSQL, and Redis, and keep control of your licensing data. Server code lives in [`src`](src/).

## License types

Licenses combine expiry, usage meters and access limits instead of selecting a fixed type.

| Use case | How it works |
| --- | --- |
| Lifetime | Leave expiry unset; the license remains eligible while it and its related resources are enabled. |
| Subscription or trial | Set an expiry date and extend it through administration when required. |
| Metered | Add usage limits, optional overage and calendar resets, such as 1,000 exports per month. |

Licenses support optional device/IP caps, IP allowlists and custom metadata. Caps are unrestricted when omitted; zero means zero capacity. Resources start disabled and must be explicitly enabled.

## Quick start

Use **Bun 1.4.2**, **PostgreSQL 17+**, and **Redis**. Start PostgreSQL and Redis before running these commands from the repository root:

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
bun run master-key
# Save the generated KZ_MASTER_KEY in .env and set KZ_DATABASE_URL and KZ_REDIS_URL.
bun run start
```

The default address is `http://localhost:6284`. For automatic restarts while developing, use `bun run dev` instead of `bun run start`.

| URL | Purpose |
| --- | --- |
| `/health` | Check server readiness and PostgreSQL/Redis availability. |
| `/validate` | Validate a license and optionally record usage. |
| `/licenses/self` | Discover the current license through its bearer credential. |

Follow the [first license example](src/README.md#first-licence), then connect your application using the [usage and replay guide](src/README.md#usage-capacity-and-replay). Generate the OpenAPI file with `bun run openapi`; it is not exposed by the running server.

**Save each credential when you create or rotate it.** Keyzori cannot show the full key again.

## Docker

Copy `.env.example` to `.env` and set `KZ_MASTER_KEY`, `KZ_POSTGRES_PASSWORD`, and `KZ_SERVER_DATABASE_PASSWORD`. Generate the root key with `bun run master-key` and use independent random, URL-safe database passwords.

```powershell
docker compose up --build -d
```

For repository-based deployment, select `compose.yml` and supply those secrets. Route your domain to the `server` service on container port `6284`, with HTTPS for remote access.

Compose starts PostgreSQL 18.0, Redis 8.2.1, and the API. It supplies internal database URLs and retains PostgreSQL data in a named volume. The server applies pending migrations before accepting requests; migration failures prevent startup.

The API is available at `http://localhost:6284`. Only the API port is published. The container runs a standalone Linux executable as a non-root user with a read-only filesystem.

See the [server guide](src/README.md#environment) for environment settings and [operations](src/README.md#operations) for backups, HTTPS proxy configuration and shutdown behaviour.

## Plugins

Installable plugins and Stripe integration are not part of this rewrite. Use the HTTP API and [webhook integrations](src/README.md#operations); webhooks are unsigned and make one delivery attempt without automatic retries.

## Development

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the server and restart it when source files change. |
| `bun run master-key` | Generate a root credential without connecting to services. |
| `bun run check` | Check types, lint, verify migrations and run the full test suite. |
| `bun run test:unit` | Run tests that do not need PostgreSQL or Redis. |
| `bun run test` | Run the full test suite with temporary Docker services. |
| `bun run db:generate` | Generate migrations after database schema changes. |
| `bun run db:migrate` | Apply pending server migrations. |
| `bun run openapi` | Generate `dist/server/openapi.json` without live services. |
| `bun run build` | Build the Linux x64 binary and API reference. |
| `bun run build linux-arm64` | Build the Linux ARM64 binary and API reference. |

Docker must be running for `bun run check` and `bun run test`. Tests use isolated PostgreSQL/Redis fixtures and fail if dependencies are unavailable. To run a subset, use `bun run test ./src/tests/http` or `bun run test ./src/tests/integration`. The [CI workflow](.github/workflows/server.yml) checks Linux x64 and ARM64. [Releases](.github/RELEASE_POLICY.md) build Linux, macOS and Windows binaries and publish binary-based Docker images.

## Documentation

The [server guide](src/README.md) describes the current rewrite. The existing [Keyzori Wiki](https://github.com/keyzori/Keyzori/wiki) documents the previous server.

| | Guide | What it covers |
| :-: | --- | --- |
| 💻 | [Deployment](src/README.md#run) | Run source, binaries or Compose. |
| ⚙️ | [Configuration](src/README.md#environment) | Environment variables and proxy settings. |
| 🔑 | [Licensing model](src/README.md#usage-capacity-and-replay) | Expiry, limits, meters and idempotent usage. |
| 🔄 | [First license](src/README.md#first-licence) | Issue, enable and validate a license. |
| 🌐 | [HTTP API](src/README.md#administration) | Routes, authentication, scopes and queries. |
| 🏗️ | [Implementation](src/IMPLEMENTATION.md) | Architecture decisions and approved contracts. |
| 📊 | [Operations](src/README.md#operations) | Monitor, back up and maintain the server. |
| 🧪 | [Verification](src/README.md#verification) | Checks and build commands. |

## Community

- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Support](https://tsukiyo.cc/join)

## License

Copyright © 2026 Keyzori contributors.

Licensed under the [Apache License 2.0](LICENSE).
