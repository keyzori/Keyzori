# Keyzori server

Self-hosted licensing with expiry dates, usage limits and device/IP controls. This rewrite needs a fresh database.

## Run

You'll need Bun 1.4.2 and Docker. From the repo root:

```sh
bun install --frozen-lockfile
bun run master-key
```

Copy `.env.example` to `.env`. Save the generated key as `KZ_MASTER_KEY` and set a random `KZ_POSTGRES_PASSWORD`, then:

```sh
docker compose up --build -d
```

The server runs at `http://localhost:6284`. Check `/health` to see if everything's ready.

## Environment

All settings are in [`.env.example`](../.env.example). Docker sets up PostgreSQL and Redis for you. Using your own? Set `KZ_DATABASE_URL` and `KZ_REDIS_URL`, then run `bun run start`. PostgreSQL 17+ is required.

## First licence

Use your root key in the `Authorization: Bearer <key>` header for the first two steps:

1. Create one: `POST /licenses` with `{}` and a unique `Idempotency-Key` header.
2. Enable it: `POST /licenses/enable` with `{"ids":["<returned id>"]}`.
3. Check it: `POST /validate` with `{"license":"<returned credential>"}`.

Save the returned `credential` straight away. You won't be able to retrieve it again.

## Administration

Manage licenses, users, items, API keys and webhooks through the API. Everything starts disabled. Use scoped API keys for everyday access and keep the root key private.

Run `bun run openapi` for the full API reference in `dist/server/openapi.json`.

License-key prefixes and separators use printable ASCII so issued credentials can be sent in bearer headers. Spaces and punctuation are preserved. Correct any older incompatible format before issuing or rotating licenses; existing credentials are not changed automatically.

JSON and query text must contain well-formed Unicode without NUL characters. Timestamps require a real calendar date and an explicit timezone, within UTC years 1–9999 and PostgreSQL's supported timezone offsets. Invalid filters and unsupported numeric ranges return `400 INVALID_REQUEST` before storage; numeric filters retain their exact decimal values.

## Usage, capacity and replay

Add expiry dates, device/IP caps or usage meters as needed. No cap means unlimited; a cap of zero allows nothing.

To count usage, include something like `"usage":{"requests":1}` in validation. Send a unique `Idempotency-Key` per operation and reuse it when retrying that same request, so usage isn't counted twice. Retries are remembered for 24 hours by default.

Check the response's `code` and `reason`: a rejected license still returns HTTP 200.

## Operations

- Use HTTPS when exposing the server online.
- Back up PostgreSQL and keep your root key safe. `docker compose down -v` deletes stored data.
- Webhooks get one attempt, with no retries or signatures.
- Use Linux for deployment. Windows builds are experimental: graceful shutdown is unverified, and Bun 1.4.2 has crashed during PostgreSQL outage testing.

## Verification

| Command | What it does |
| --- | --- |
| `bun run dev` | Run locally and reload changes. |
| `bun run check` | Run all checks and tests; Docker must be running. |
| `bun run build` | Build the Linux x64 binary and API reference. |
| `bun run build linux-arm64` | Build the Linux ARM64 binary and API reference. |
| `bun run build windows-x64` | Build the Windows x64 binary and API reference. |
| `bun run build darwin-x64` | Build the macOS Intel binary and API reference. |
| `bun run build darwin-arm64` | Build the macOS Apple Silicon binary and API reference. |

Builds land in `dist/server/`. Run the binary with the same `.env` settings. Development runs straight from source. See [implementation notes](IMPLEMENTATION.md) for the deeper details.

GitHub releases include all five binary archives, checksums and the API reference. Release images support Linux AMD64/ARM64 and run the compiled binary in a non-root distroless container.
