# Contributing

Keyzori runs directly from TypeScript using Bun. Use the exact runtime from `.bun-version` and `.bun-revision`; dependency versions remain locked, including the Elysia 2 beta and Drizzle 1 release candidate.

```sh
bun doctor
bun install --frozen-lockfile
bun check --types
bun lint
bun run test:unit
```

`bun doctor` checks the full revision, not just `bun --version`, and reads direct installed package manifests to compare their versions with exact dependency pins. A current lockfile alone does not prove installed directories match it. The pin is `bun@1.4.4-canary.20261022.1`, revision `1.4.4-canary.1+963452075`; Bun types are `1.4.4`. The shared CI setup action and Dockerfile install this exact package and verify its revision. Moving canary tags are not substitutes. Update runtime pins, `packageManager`, and verified revision together.

`bun check --types` is a narrow diagnostic and does not start external services. It deliberately remains available when diagnosing a runtime mismatch; report the actual revision with results. `bun check` requires the pin and runs types, lint, schema verification and all tests.

Set up the environment using the [server guide](src/README.md). Direct Bun development loads the local `.env` conventionally; the container explicitly disables environment-file loading and uses its supplied environment. Generate the environment master credential with `bun run master-key`.

## Database and testing

Use Drizzle. Run `bun run db:generate` for schema changes and review the generated SQL. `bun run db:migrate` is an explicit operation using `KZ_MIGRATION_DATABASE_URL`; the runtime uses `KZ_DATABASE_URL` and verifies exact history without changing schema. The migration command needs neither Redis nor an API master key. An incompatible or unversioned nonempty database is refused without modifying data.

`bun run db:check` independently generates a fresh Drizzle schema, applies it and the committed SQL to separate disposable databases, and compares columns, defaults, constraints, indexes, enums, triggers, sequences, functions and row policies. It also checks that migration execution leaves cluster-wide role authority unchanged; runtime-role privilege tests cover the separate deployment grants. It requires Docker. Database/API tests run through `bun run test <test-paths>`. Each test-service invocation owns uniquely labelled containers and removes only inspected owned container IDs. Concurrent runs do not share a state file; interrupted startup and all-settled cleanup have deadlines and focused regression coverage.

Add regression coverage for changed behavior. Use the smallest relevant checks and follow the user's current approval/validation limits. Do not run a full suite or Docker checks when they have been held. Do not weaken checks to hide failures.

## Runtime and delivery

`bun run start` serves source; no application executable is built. The Docker image includes the pinned Bun runtime, production dependencies, source, migrations and LICENSE. It runs as UID 65532 with a read-only root filesystem under Compose. An explicit migrator job owns schema changes; the server role has no DDL or migration-history writes. Audit and accepted usage history are append-only to the runtime role.

Runtime packaging changes require the source/container/Compose smoke checks before qualification. These checks use disposable data and share consumption/replay/rotation, credential secrecy and WebSocket reconnect/authorization/shutdown assertions. Linux source and exact-image checks also run the real signer/dispatcher against an isolated local TLS receiver, including certificate trust, redirects, cancellation and an in-flight shutdown barrier. They require OpenSSL and Linux Docker networking; Windows smoke output identifies this coverage limit. The Compose smoke additionally verifies restricted database privileges, persistence, disabled-key retention and the non-root read-only runtime.

Use `bun fmt <paths>` for scoped formatting, tabs, double quotes and extensionless imports. Use Conventional Commits and describe behavior, verification and breaking effects. [Release policy](.github/RELEASE_POLICY.md) covers the main-branch release process; `v3` pushes only run CI. Do not deploy, publish, merge or reset data without the task's authorization.

Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
