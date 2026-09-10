# Stripe plugin

Set these variables in the server environment:

```text
KEYZORI_PLUGINS=stripe
KEYZORI_STRIPE_SECRET_KEY=sk_test_...
KEYZORI_STRIPE_WEBHOOK_SECRET=whsec_...
```

Run `bun run setup` and `bun run db:migrate` before starting. Compose provides a one-shot migration service using the same application image. The plugin owns its dependency manifest and lockfile; nothing installs during server startup. Its generated migrations use the independent `keyzori_migrations.plugin_stripe` journal. Enabling the plugin requires running migrations before server startup.

The root Compose files forward optional `.env` values to the server without naming individual plugins. Put this plugin's variables in `.env` when using Compose, or supply them directly to the container environment.

Configure Stripe to send subscription and invoice events to `POST /plugins/stripe/webhook`. Signatures are verified against raw bytes. Verified event identifiers and routing fields are persisted before acknowledgment; payloads and credentials are not saved. Duplicate delivery is deduplicated. A recoverable worker claims events and reconciles current subscription state instead of trusting event order. Failed processing retries with exponential delay capped at one hour.

Administrative routes are under `/plugins/stripe/admin` and require `X-Admin-Key`:

| Method | Route | Purpose |
| --- | --- | --- |
| GET/POST | `/links` | List or link an existing subscription |
| DELETE | `/links/:licenseId` | Unlink and clear this plugin's billing block |
| POST | `/links/:licenseId/sync` | Reconcile current provider state |
| GET | `/events` | Inspect processing state |
| POST | `/events/:eventId/retry` | Retry a persisted event by its resource UUID |

Create a subscription license, then link `{ "licenseId": "...", "subscriptionId": "sub_..." }`. Active/trialing subscriptions with a future period end permit billing access. Other states, a missing subscription, or incompatible license type block it. Synchronization updates the subscription expiry. Provider errors retain the last persisted restrictions and trigger retries.

Manual and billing blocks are independent. Billing recovery and unlinking cannot clear manual revocation. Disabling the plugin removes its routes/workers while retaining all persisted tables, links, and restrictions.

CLI: set `KEYZORI_PLUGINS=stripe`, then run `bun run cli -- stripe --help`. Commands cover link, unlink, sync, links, events, and retry. The core CLI discovers this extension automatically.

Local tests use real PostgreSQL/Redis, signed fixtures, and a simulated provider. They do not contact a live Stripe account.
