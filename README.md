<div align="center">

<img width="2560" height="720" alt="Keyzori banner" src="https://raw.githubusercontent.com/keyzori/Keyzori/main/.github/assets/banner.png" />

[`📖 Documentation`](https://github.com/keyzori/Keyzori/wiki) · [`🌐 API`](https://github.com/keyzori/Keyzori/wiki/API-Reference) · [`💻 Deployment`](https://github.com/keyzori/Keyzori/wiki/Deployment)

<br />

</div>

> [!WARNING]
> The current release changes the API, settings, and database format. Start with a fresh PostgreSQL database; older databases and client integrations are not compatible.

Keyzori is a self-hosted license server for software products. Create customers and licenses, control which devices can connect, and track usage through an HTTP API or command-line tool.

You host the server, PostgreSQL, and Redis, and keep control of your licensing data.

## License types

| Type | How it works |
| --- | --- |
| `lifetime` | Stays valid without an expiry date, unless you block access. |
| `subscription` | Works until a set expiry date. Renew it yourself or sync an existing Stripe subscription. |
| `metered` | Tracks usage against limits you set, such as 1,000 exports. |
| `trial` | Runs for a set number of seconds, starting at the first successful activation. |

Every type supports device, IP, and active-session limits, allowlists, and custom metadata. By default, a license allows one registered device, one registered IP, and one active session.

## Quick start

Use **Bun 1.3.14 or newer**, **PostgreSQL**, and **Redis**. Start PostgreSQL and Redis before running these commands from the repository root:

```powershell
Copy-Item .env.example .env
# Edit .env: set your database and Redis URLs and a random KEYZORI_ADMIN_KEY.
# The admin key must contain at least 32 characters.
bun run setup
bun run db:migrate
bun run start
```

The default address is `http://localhost:3000`. For automatic restarts while developing, use `bun run dev` instead of `bun run start`.

| URL | Purpose |
| --- | --- |
| `/health` | Check that the server responds. |
| `/ready` | Check that the server can reach PostgreSQL and Redis. |
| `/docs` | Browse and try the HTTP API. |

Use `bun run cli -- --help` to view admin commands. [Create your first customer and license](https://github.com/keyzori/Keyzori/wiki/Product-Flow), then connect your application using the [runtime guide](https://github.com/keyzori/Keyzori/wiki/Runtime-Flow).

**Save each `lic_...` key when you create or rotate it.** Keyzori cannot show the full key again.

## Docker

Copy `.env.example` to `.env` and set `KEYZORI_ADMIN_KEY` and `KEYZORI_POSTGRES_PASSWORD`. Use a random admin key of at least 32 characters and a URL-safe database password, such as a random hexadecimal value.

```powershell
docker compose up --build -d
docker compose exec server bun src/main.ts admin --help
```

Compose starts PostgreSQL, Redis, a one-time database setup service, and the API. It supplies the internal database URLs and stores data in named volumes. The API is available at `http://localhost:3000` and is bound to localhost by default.

The container runs TypeScript directly with Bun as a non-root user. See [Deployment](https://github.com/keyzori/Keyzori/wiki/Deployment) for upgrades, HTTPS, and image settings.

## Plugins

Plugins are off by default. To enable the included Stripe plugin, set `KEYZORI_PLUGINS=stripe` along with `KEYZORI_STRIPE_SECRET_KEY` and `KEYZORI_STRIPE_WEBHOOK_SECRET`, then install dependencies, apply migrations, and restart the server.

Stripe syncs existing subscriptions with subscription licenses. It does not create a checkout or customer portal. See [Plugins](https://github.com/keyzori/Keyzori/wiki/Plugins) for setup and examples.

## Development

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the server and restart it when source files change. |
| `bun run cli:help` | Show admin commands. |
| `bun run check` | Check types, run tests, lint code, and check migrations. |
| `bun run test:unit` | Run tests that do not need PostgreSQL or Redis. |
| `bun run test:local` | Run the full test suite with temporary Docker services and coverage. |
| `bun run db:generate` | Generate migrations after database schema changes. |
| `bun run db:migrate` | Apply pending migrations for the server and enabled plugins. |
| `bun run docker:build` | Build the server image. |
| `bun run docker:smoke` | Check the container and Compose setup using temporary services. |

Tests that need PostgreSQL and Redis are skipped by `bun run check` unless test URLs are configured. Use `bun run test:local` for the full suite. See [Contributing](CONTRIBUTING.md) for development guidance.

## Documentation

The **[Keyzori Wiki](https://github.com/keyzori/Keyzori/wiki)** covers setup, integration, and day-to-day use.

| | Guide | What it covers |
| :-: | --- | --- |
| 💻 | [Deployment](https://github.com/keyzori/Keyzori/wiki/Deployment) | Run and update the server. |
| ⚙️ | [Configuration](https://github.com/keyzori/Keyzori/wiki/Configuration) | Settings, defaults, and allowed values. |
| 🔑 | [Licensing model](https://github.com/keyzori/Keyzori/wiki/Licensing-Model) | License types, limits, and usage. |
| 🔄 | [First license](https://github.com/keyzori/Keyzori/wiki/Product-Flow) | Create a customer and issue a key. |
| ⏱️ | [Runtime flow](https://github.com/keyzori/Keyzori/wiki/Runtime-Flow) | Connect your application and keep a session active. |
| 🌐 | [HTTP API](https://github.com/keyzori/Keyzori/wiki/API-Reference) | Routes, authentication, and request examples. |
| 💾 | [Admin CLI](https://github.com/keyzori/Keyzori/wiki/CLI-Reference) | Manage Keyzori from a terminal. |
| 🧩 | [Plugins](https://github.com/keyzori/Keyzori/wiki/Plugins) | Enable Stripe or build a plugin. |
| 🏗️ | [Architecture](https://github.com/keyzori/Keyzori/wiki/Architecture) | Where the code and data live. |
| 📊 | [Operations](https://github.com/keyzori/Keyzori/wiki/Operations) | Monitor, back up, and maintain the server. |
| 🩺 | [Troubleshooting](https://github.com/keyzori/Keyzori/wiki/Troubleshooting) | Find the cause of common errors. |

## Community

- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Support](https://tsukiyo.cc/join)

## License

Copyright © 2026 Keyzori contributors.

Licensed under the [Apache License 2.0](LICENSE).
