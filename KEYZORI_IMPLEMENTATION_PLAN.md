# Keyzori v3 implementation plan

**Target:** `C:\Users\LilSnibbi\Desktop\Keyzori`, branch `v3`.

Complete the existing redesign through small, independently reviewed changes. Treat the previous agents’ implementation as candidate code: retain sound mechanisms, correct defects, and require evidence before marking findings resolved.

## 1. Verified starting point

The checkout matches the audit’s original commit, `1a9ee34`, but now contains **151 changed tracked paths and 53 untracked paths**.

Useful implementation already exists:

- Groups and users with optional licence associations.
- Non-consuming validation and separate atomic consumption.
- Empty initial API-key permissions and group restrictions.
- Transactional authorization rechecks.
- Durable events, WebSockets, signed retryable webhooks.
- Direct Bun source execution and separate migration/runtime roles.

The review identified corrective work:

| Area            | Current gap                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group isolation | Transfers can expose old-group audit values to destination-group readers; full licence reads can combine authorization and data from different revisions. |
| Idempotency     | Successful deletion retries can fail before retrieving their saved receipt.                                                                               |
| Webhooks        | An expired lease can terminally fail an unsent delivery.                                                                                                  |
| Events          | Counter changes lack promised events; payloads remain all-optional rather than event-specific.                                                            |
| Counters        | `startsAt` documentation contradicts implementation; recurring anchors need a clear contract.                                                             |
| Maintenance     | A sufficiently large prefix of failing records can repeatedly starve healthy work.                                                                        |
| HTTP/reference  | Spoofed upgrade headers bypass response wrapping; OpenAPI contains query and idempotency discrepancies.                                                   |
| Verification    | Several replacement tests dropped meaningful transport, concurrency and shutdown coverage.                                                                |
| Migrations      | The original baseline is deleted and replacement migrations are untracked; their applied status is unknown.                                               |

These are static-review findings, not reproduced exploits or performance measurements.

The selected Bun revision is also mismatched: **`081ace731` locally versus pinned `963452075`**. Qualification must use the intended runtime.

## 2. Binding design decisions

### Domain and validation

- Groups remain neutral containers; users remain separate entities.
- Disabling a group blocks its keys without changing their individual state.
- Deleting a group atomically disables and detaches its keys. Existing custom disable reasons remain meaningful.
- Deleting a user deletes their associated keys while preserving appropriately redacted historical evidence.
- Expected-group validation retains three meanings:
  - omitted: no expected-group comparison;
  - group ID: require that group;
  - `null`: require an ungrouped key.
- Validation returns complete licence-domain information, including metadata, associated group/user information, expiry, counters, **registered IPs and hardware identifiers**.
- **Administrative notes are excluded**, including notes nested within group/user records. Use explicit field projections rather than spreading database rows.
- Known disabled keys return their custom reason. Unknown credentials disclose no resource information.
- Validation neither consumes usage nor fails because a counter is exhausted.

### Permissions

- API-key creation always starts with no permissions; permissions are edited separately.
- Keep master-only API-key/grant administration.
- Selected-group keys exclude ungrouped keys; all-group authority includes them.
- Retain conservative boundaries for global user mutations and group creation: appropriate action permission plus all-group authority.
- Define composite-read permissions explicitly so licence, usage and registration endpoints do not accidentally contradict one another.
- API keys have fixed descriptive fields, no custom metadata. The environment master credential is never a listed resource or response value.
- **Ordinary API keys require `usage:consume` and appropriate group access.** The environment master retains unrestricted access, including consumption; licence credentials cannot consume.

### Counters

Recommended contract:

- No counters unless configured.
- Default counter: unlimited, no reset, integer precision.
- Exact decimal-string inputs and outputs; PostgreSQL performs arithmetic.
- Calendar resets support daily, weekly, monthly and yearly periods, UTC by default and explicit supported timezones.
- Periods are half-open: `[start, end)`.
- Month-end clamping returns to the original requested day in subsequent months; leap-day handling is explicit.
- Preserve and document PostgreSQL’s DST gap/overlap resolution.
- Distinguish **consumption start** from **recurring reset anchor**. An explicit future start rejects consumption before that instant without invalidating the licence; an anchor determines recurring boundaries.
- Counter edits and manual resets have revisions/generations recorded in usage evidence.

## 3. Implementation phases

### Phase 0 — Reconcile the existing work

**Scope:** entire tracked/untracked diff, instructions, manifests, lockfile and migrations.

1. Account for every changed, added and deleted file.
2. Preserve the package/lock changes that predate the redesign.
3. Identify unrelated changes and keep them out of task commits.
4. Map **F01–F23** to current evidence, required correction, superseded recommendation or measurement task.
5. Select the pinned Bun runtime and reconcile documentation with actual commands.
6. Establish whether any replacement migration has been applied before changing its history.

**Exit:** an attributable starting diff, clear migration disposition, and a reproducible toolchain.

### Phase 1 — Finalize contracts and authorization boundaries

**Scope:** `src/types/`, HTTP models, response handling, authorization registry, OpenAPI.

- Create a typed operation registry covering every HTTP operation, WebSocket action and webhook event family.
- Make public endpoints explicit; unknown or undeclared operations default to denial.
- Use one response/error envelope with request IDs, pagination, retryability, safe field errors and replay information.
- Keep validation decisions distinct from malformed requests, authorization failures and dependency failures.
- Make collection/detail response shapes stable and bulk operations explicitly bounded.
- Correct the header-controlled response-envelope bypass.
- Define bearer and administrative licence projections, applying the notes exclusion recursively.
- Derive reference metadata from authoritative contracts, including required idempotency headers and exact query bounds.

**Exit:** a complete permission/response matrix and matching runtime types, schemas and reference output.

### Phase 2 — Repair authorization and historical evidence

**Scope:** `AuthService`, `LicenseService`, `LicenseView`, `AuditService`, group/user services and receipt authorization.

- Make full-resource reads use one coherent authorized snapshot or suitable narrow locking.
- Capture source and destination group context during transfers.
- Prevent destination-only audit readers from seeing source-group historical values.
- Define safe transfer notifications for both groups, including transitions to/from ungrouped.
- Capture failed-validation authorization context at evaluation time.
- Repair deletion replay using retained authorization evidence rather than requiring deleted rows to exist.
- Recheck current caller permissions on receipt retrieval.
- Add separately authorized historical consumption lookup so accepted operations remain investigable after lifecycle changes.
- Replace unsafe large-parent-deletion guidance with a bounded, audited workflow preserving disable/cascade guarantees.

**Exit:** deterministic cross-group, revocation, deletion and lost-response tests pass without weakening current authorization.

### Phase 3 — Finish consumption and database integrity

**Scope:** counter services/schedules, usage operations, Drizzle schema, transactions and migrations.

- Resolve start/anchor behavior consistently across code, schemas, examples and documentation.
- Record stable counter ID, definition revision, period identity and reset generation.
- Preserve stable operation identity across credential rotation and counter resets.
- Ensure multi-counter rejection rolls back balances, reset writes, usage records, receipts, audits and events together.
- Preserve database-clock evaluation after lock acquisition, exact arithmetic and indeterminate-COMMIT recovery.
- Review constraints, indexes, settings validation and credential-collision handling.
- Retain topology coordination until replacement parent/resource locking passes equivalent concurrency tests.
- Generate and review Drizzle migrations; compare actual disposable schemas and test role privileges.
- Serving continues to verify compatibility without applying migrations or repairing data.

**Exit:** concurrency, reset boundaries, replay recovery, schema equivalence and runtime-role restrictions are verified.

### Phase 4 — Complete audit history and WebSocket delivery

**Scope:** `src/plugins/activity/`, audits, event production, event schemas and publication.

- Replace all-optional payloads with versioned, discriminated event contracts.
- Emit every advertised mutation event, including counter definition changes and adjustments.
- Preserve atomic domain/audit/outbox writes and post-commit publication sequencing.
- Add resource revisions needed for reliable replay and state reconciliation.
- Define deletion/transfer visibility using retained historical context and current permissions.
- Implement explicit restore-epoch handling and a coherent cursor-expiry/resynchronization protocol.
- Retain backend WebSocket authentication; document developer-owned backend relays for browsers.
- Verify authorization on subscription and delivery, distributed connection leases, message limits, backpressure, session expiry, reconnect and shutdown.
- Keep audit history, integration events and operational logs distinct.

**Exit:** rollback emits nothing; reconnect has no replay/live gap; revoked or slow clients cannot retain unauthorized delivery or unbounded buffers.

### Phase 5 — Correct and qualify webhook delivery

**Scope:** webhook authority, dispatcher, transport, encryption, attempts and receiver examples.

- Separate expired lease ownership from revoked authority and terminal destination failures.
- Recover unsent work safely; stale workers cannot settle another claim.
- Isolate failing endpoints and bound per-endpoint concurrency and backlog.
- Retain current permission/group checks, destination versioning and cancellation on configuration changes.
- Preserve public-HTTPS defaults, connection-time address validation, TLS hostname verification and redirect refusal.
- Keep signing over documented exact bytes, encrypted secrets and explicit rotation behavior.
- Retain the current **eight attempts within 24 hours** as the initial documented retry policy, with bounded backoff and `Retry-After`.
- Provide permissioned replay/recovery with clear duplicate semantics.
- Restore real local TLS, timeout, cancellation and shutdown tests alongside mocked state-machine tests.

**Exit:** crash/lease/send/settlement scenarios recover predictably; signatures and egress restrictions work through the real transport. Delivery remains at least once.

### Phase 6 — Complete operations and performance work

**Scope:** maintenance, health, metrics, logging, database queries and recovery procedures.

- Fix poison-record starvation across maintenance passes.
- Use configurable row/time budgets and expose backlog age, publication lag, webhook backlog and stream queue metrics.
- Define retention separately for events, audits, accepted usage, administrative receipts and webhook attempts.
- Preserve accepted-operation deduplication when changing retention; never silently prune unfinished work.
- Complete liveness/readiness/privileged diagnostics and useful redacted failure causes.
- Measure supported queries and query counts before selecting additional indexes or removing broad locks.
- Test restoration into disposable infrastructure, including signing encryption material, stream epoch changes and controlled pending-webhook resumption.

**Exit:** bounded work, observable backlogs, tested recovery and measured performance conclusions.

### Phase 7 — Repository-wide completion

**Scope:** application, tests, examples, scripts, root configuration, dotfiles, CI, Husky and documentation.

- Finish source-based packaging and strengthen the shared runtime contract used by source/container/Compose checks.
- Preserve non-root/read-only container behavior.
- Correct OpenAPI discrepancies and validate generated output against actual HTTP behavior.
- Reject older draft releases incompatible with the v3 publication contract.
- Verify fixture ownership, concurrent runs, interrupted startup and cleanup failures.
- Update README, contributor guidance, implementation notes, environment examples and developer examples.
- Remove conflicting domain terminology and obsolete Prisma/executable instructions.
- Split oversized security-sensitive services by responsibility where it improves reviewability.
- Complete applicable provenance, notices and dependency/image pinning work.

**Exit:** every repository area is accounted for and documentation claims match verified behavior.

## 4. Subagent execution model

Use bounded ownership after contract decisions are settled:

| Workstream              | Responsibility                                                       |
| ----------------------- | -------------------------------------------------------------------- |
| Authorization/contracts | Permissions, projections, HTTP contract and historical authorization |
| Domain/database         | Groups/users, counters, transactions, schema and migrations          |
| Activity/webhooks       | Event production, WebSockets, delivery state machine and transport   |
| Operations/tooling      | Maintenance, diagnostics, fixtures, CI, packaging and documentation  |

The lead owns shared-contract changes, integration and final acceptance. Each security-sensitive slice receives review by someone other than its implementer. Shared files have one owner at a time.

Tests must verify behavior and failure boundaries; replacing assertions to accommodate accidental behavior is not acceptance.

## 5. Verification and delivery gates

Run focused checks first, using disposable data:

- `bun doctor`
- `bun check --types`
- Scoped lint and relevant unit/HTTP/integration tests.
- Real concurrency barriers for transfer, revocation, deletion and consumption.
- Real WebSocket and local HTTPS webhook tests.
- Drizzle schema/history/privilege verification.
- Source, container and Compose runtime checks.

Respect active approval limits before full `bun check`, Docker matrices or resource-heavy benchmarks. The audit’s old passing tests do not establish the current diff’s correctness.

Before completion:

1. Independently review the final diff and F01–F23 dispositions.
2. Commit only reviewed task changes, including accepted prior-agent work.
3. Push to **`origin/v3` without force-pushing**.
4. Verify the remote SHA and relevant CI for that exact commit.
5. Report implemented behavior, trade-offs, passed/failed checks, unverified areas and remaining blockers.

Persistent-data resets, live migrations, deployment, package publication and merges retain their required approval gates.

## 6. Supplied audit inputs

All supplied files are included as planning inputs under:

[**Audit directory**](C:/Users/LilSnibbi/.codex/visualizations/2026/11/06/01a1aedf-29e4-7ea3-b338-c74621a3a359/keyzori-audit)

- **Primary:** `Keyzori-audit-and-implementation-plan.md`
- **Supporting reviews:** `security.md`, `database.md`, `build.md`
- **Supporting analysis:** `audit-findings.md`, `root-notes.md`, `target-plan.md`, `implementation-plan.md`
- **Historical research:** `prisma-distribution.md`, `sources.md`
- **Coverage/provenance:** `coverage-ledger.md`, `inventory.json`, `coverage.json`, `root-coverage.json`, `security-coverage.json`, `database-coverage.json`, `build-coverage.json`, `integrity.json`

Your decisions supersede the reports’ Prisma, feature-entitlement, private-metadata, SSE and executable-distribution proposals.

Current official [Elysia beta WebSocket](https://next.elysiajs.com/patterns/websocket/), [lifecycle](https://next.elysiajs.com/essential/life-cycle/), [Drizzle transaction](https://orm.drizzle.team/docs/transactions), [Bun WebSocket](https://bun.com/docs/runtime/http/websockets) and PostgreSQL documentation informed this plan; installed-version compatibility still needs execution checks.

**Historical planning review status:** the saved plan recorded no project changes or tests during planning. Implementation has since been explicitly approved; this file preserves that full plan as the implementation reference.

**Implementation clarification:** the user confirmed that no v3 code has been deployed. The previous draft diff is candidate implementation, not a design constraint; the binding user decisions above govern the completed redesign.
