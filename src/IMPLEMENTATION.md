# V2 implementation

This guide describes the current server code. For setup and API examples, use the [server guide](README.md). V2 changes the API, environment variables and database schema; it requires a fresh PostgreSQL database and does not provide an in-place v1 migration.

## Structure and startup

[main.ts](main.ts) handles version reporting, root-key generation, healthchecks, migrations and server startup. [app.ts](app.ts) composes the Elysia routes. Features keep their routes, models and services under `plugins/`; shared infrastructure lives under `core/`.

[Config](core/config/Config.ts) validates runtime environment settings, including database/Redis URLs, the root key, listener address, port and trusted proxy settings. [ServerServices](core/ServerServices.ts) creates the shared infrastructure and supplies dependencies to feature services.

[ServerLifecycle](core/ServerLifecycle.ts) applies migrations, connects Redis and checks both dependencies before listening. It runs scheduled maintenance and webhook dispatch after startup. Shutdown marks the server as draining, stops background work and gives active work up to 25 seconds to finish before forcing the server to stop and closing connections. Linux runtime checks exercise this behavior; Windows shutdown remains unverified.

## Requests and access

[HttpBoundary](core/http/HttpBoundary.ts) handles parsing and errors, while the request tracker records request IDs and completion. [RequestService](core/http/RequestService.ts) combines authentication, client-IP resolution, rate limiting and operational settings for feature routes.

Administrative routes require authentication. Root-only routes require the root credential; API keys have explicit scope grants. `POST /validate` takes the license credential in its JSON body. License bearer credentials can read their self-service view and, with an explicit ID query, their own license or linked user/item. They cannot mutate resources or read unrelated ones. See [AuthService](core/auth/AuthService.ts), [ScopeService](core/auth/ScopeService.ts) and the [HTTP authorization tests](tests/http/authorization.test.ts).

## Persistence and replay

PostgreSQL stores licensing state, metadata, audit records and idempotency receipts. [Database](core/database/Database.ts) supplies transactional access. Redis supplies shared rate limiting; it is not the persistent license database. Database and Redis outage/recovery behavior is exercised in the [integration tests](tests/integration/outages.test.ts).

[MigrationService](core/database/MigrationService.ts) serializes migration execution with a PostgreSQL advisory lock, verifies existing migration history against bundled assets and applies pending migrations transactionally. Modified or incompatible history is rejected. A nonempty database without v2 history is refused before creating migration state, including v1 databases and v2 databases whose history is missing or empty. The [compatibility tests](tests/integration/migration-compatibility.test.ts) verify that rejected databases retain their schema and data. The [database tests](tests/integration/database.test.ts) cover repeated/concurrent migrations, transaction rollback and exact PostgreSQL data semantics.

[ValidationService](plugins/validate/ValidationService.ts) locks the license and applies usage updates and device/IP registrations in one database transaction. The [validation tests](tests/integration/validation.test.ts) verify competing registrations, final-unit consumption and rollback when a meter rejects an operation.

[IdempotencyService](core/security/IdempotencyService.ts) records completed operations and checks request fingerprints on replay. Reusing a key for a different request within the same operation and principal is rejected. Secret issuance does not disclose plaintext again on retry. See the [replay-policy tests](tests/integration/replay-policy.test.ts) and [HTTP contract tests](tests/http/contracts.test.ts).

## Deployment and verification

[Compose](../compose.yml) uses separate PostgreSQL administrator and server-role passwords. The [database initialization script](../deploy/postgres/01-roles.sh) creates the restricted server role, which the API uses to connect. PostgreSQL data lives in a named volume; removing that volume deletes the data.

[version.ts](version.ts) reads the version from `package.json`. Source development uses Bun; the [Dockerfile](Dockerfile) builds a standalone executable and runs it in a non-root distroless container. Runtime settings are supplied at execution time.

The [Server workflow](../.github/workflows/server.yml) checks Linux x64 and ARM64, including type/lint/migration checks, the test suite, build verification, runtime/container smoke checks and Compose persistence. Its `Required checks` job aggregates workflow validation and both Linux verification jobs. These checks do not establish a bug-free implementation or verify macOS runtime behavior.

For tagging, binary assets and Docker publication, see the [release policy](../.github/RELEASE_POLICY.md). Release Please targets only `main`; merging its release PR publishes the release. Preparing an integration PR does not publish anything.
