<div align="center">

<img width="2560" height="720" alt="Keyzori banner" src="https://raw.githubusercontent.com/lilsnibbi/Keyzori/main/.github/assets/banner.png" />

[`📖 Documentation`](https://github.com/lilsnibbi/Keyzori/wiki) · [`🌐 API`](https://github.com/lilsnibbi/Keyzori/wiki/API-Reference) · [`🔧 SDK`](apps/sdk/README.md) · [`💻 Deployment`](https://github.com/lilsnibbi/Keyzori/wiki/Deployment)

<br />

</div>

> [!WARNING]
> Keyzori is under active development. This release intentionally contains breaking API and database naming changes.

Keyzori is a self-hosted licensing server for software products. It provides a typed client SDK, an operator CLI, and an HTTP API for managing customers, licenses, access policies, usage meters, and runtime sessions.

You control the server, PostgreSQL database, Redis instance, and licensing data.

## License types

| Type           | Behavior                                                                           |
| -------------- | ---------------------------------------------------------------------------------- |
| `lifetime`     | No type-level expiry or usage balance.                                             |
| `subscription` | Requires an expiry and supports manual or optional Stripe renewal synchronization. |
| `metered`      | Uses explicit, idempotent consumption against named integer meters.                |
| `trial`        | Starts a positive duration atomically on first activation.                         |

Every license type can use IP, device, session, allowlist, metadata, revocation, and access-management controls.

Type changes preserve the secret and shared policy while keeping former type settings as dormant drafts.

## Quick start

Keyzori requires **Bun**, **PostgreSQL**, and **Redis**.

```powershell
Copy-Item .env.example .env

# Replace every placeholder secret and configure dependency URLs.

bun run setup
bun run dev
```

The API starts at `http://localhost:3000`.

| URL       | Purpose                                    |
| --------- | ------------------------------------------ |
| `/health` | Process liveness                           |
| `/ready`  | PostgreSQL and Redis readiness             |
| `/docs`   | Interactive operator/runtime API reference |

Use `keyzori admin` or the authenticated `/admin/*` API to create a customer and license.

The full `lic_...` secret is returned only after creation or rotation. **Store it immediately.**

## SDK integration

```typescript
import { LicenseClient } from "keyzori";

const license = new LicenseClient({
  licenseKey: process.env.KEYZORI_LICENSE_KEY ?? "",
  serverUrl: "https://licenses.example.com",
  deviceId: process.env.KEYZORI_DEVICE_ID,
});

const { licenseType, metadata } = await license.activate();

await license.consume({
  meter: "exports",
  units: 1,
  eventId: crypto.randomUUID(),
});

await license.deactivate();
```

Only activation sends the license secret.

Automatic heartbeats, usage reporting, and deactivation use a bound server-issued session token.

See the [`SDK Reference`](https://github.com/lilsnibbi/Keyzori/wiki/SDK-Reference) and [`Runtime Flow`](https://github.com/lilsnibbi/Keyzori/wiki/Runtime-Flow) documentation for the complete runtime model.

## Docker

```powershell
docker compose --file dev.docker-compose.yml up --build -d

docker compose --file dev.docker-compose.yml exec server keyzori admin --help
```

The server image runs as non-root with a read-only filesystem and contains one compiled `keyzori` executable.

Available commands include:

```text
keyzori serve
keyzori admin ...
keyzori healthcheck
```

Stripe controls and webhook processing are absent unless both of the following variables are configured:

```text
KEYZORI_STRIPE_SECRET_KEY
KEYZORI_STRIPE_WEBHOOK_SECRET
```

Keyzori links existing subscriptions only. It does not provide Checkout, a customer portal, or end-user licensing controls.

## Development

| Command                       | Purpose                                       |
| ----------------------------- | --------------------------------------------- |
| `bun run dev`                 | Start the API in watch mode                   |
| `bun run cli:help`            | Show local operator commands                  |
| `bun run build`               | Build the unified server executable and SDK   |
| `bun run typecheck`           | Type-check all workspaces and cross-app tests |
| `bun run test`                | Run the test suite                            |
| `bun run check`               | Run release-level verification                |
| `bun run db:generate`         | Generate a migration after schema changes     |
| `bun run db:migrate`          | Apply committed migrations                    |
| `bun run docker:build`        | Build the optimized server image              |
| `bun run docker:build:server` | Alias for the unified image build             |

## Documentation

Full documentation is available in the **[Keyzori Wiki](https://github.com/lilsnibbi/Keyzori/wiki)**.

|     | Guide                                                                        | What it covers                                                        |
| :-: | :--------------------------------------------------------------------------- | :-------------------------------------------------------------------- |
|  💻 | [Deployment](https://github.com/lilsnibbi/Keyzori/wiki/Deployment)           | Compose, standalone container, reverse proxy, releases, native binary |
|  ⚙️ | [Configuration](https://github.com/lilsnibbi/Keyzori/wiki/Configuration)     | Every `KEYZORI_` variable, with defaults and accepted ranges          |
|  🔑 | [Licensing model](https://github.com/lilsnibbi/Keyzori/wiki/Licensing-Model) | The four types, effective status, limits, allowlists, and meters      |
|  🔄 | [Product flow](https://github.com/lilsnibbi/Keyzori/wiki/Product-Flow)       | Operator setup, application runtime, and operator feedback loop       |
|  ⏱️ | [Runtime flow](https://github.com/lilsnibbi/Keyzori/wiki/Runtime-Flow)       | Activation, session binding, heartbeat, and validation order          |
| 🏗️ | [Architecture](https://github.com/lilsnibbi/Keyzori/wiki/Architecture)       | One binary, three entrypoints, layer boundaries, and storage          |
|  🔧 | [SDK reference](https://github.com/lilsnibbi/Keyzori/wiki/SDK-Reference)     | The `keyzori` package, configuration, methods, events, and errors     |
|  🌐 | [HTTP API](https://github.com/lilsnibbi/Keyzori/wiki/API-Reference)          | Routes, request/response shapes, and error codes                      |
|  💾 | [Admin CLI](https://github.com/lilsnibbi/Keyzori/wiki/CLI-Reference)         | `keyzori admin` commands for customers, licenses, access, and meters  |
|  📊 | [Operations](https://github.com/lilsnibbi/Keyzori/wiki/Operations)           | Monitoring, backup/restore, secret rotation, and incident playbooks   |
|  🩺 | [Troubleshooting](https://github.com/lilsnibbi/Keyzori/wiki/Troubleshooting) | Symptom-first fixes for startup, licensing, Stripe, and migrations    |

## Community

* [Contributing](CONTRIBUTING.md)
* [Governance](GOVERNANCE.md)
* [Support](https://tsukiyo.cc/join)

## License

Copyright © 2026 Keyzori contributors.

Licensed under the [Apache License 2.0](LICENSE).
