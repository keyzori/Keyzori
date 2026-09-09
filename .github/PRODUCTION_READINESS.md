# Production readiness

This document is the release gate for operating Keyzori with real customer licenses. Passing unit tests alone is not sufficient.

## Implemented gates

- Strict environment validation, including non-placeholder 32-character minimum admin secrets.
- Fail-fast PostgreSQL migration and Redis connection during startup.
- Separate liveness (`/health`) and dependency readiness (`/ready`) endpoints.
- Graceful `SIGINT` and `SIGTERM` handling.
- Non-root, multi-stage runtime image with a pinned Bun builder version.
- Default-off proxy-header trust restricted to explicit immediate-proxy CIDRs, atomic request rate limits, bounded request/response bodies, and bounded public string inputs.
- Security response headers and disabled response caching.
- Unit, cross-application, artifact smoke, and live PostgreSQL/Redis CI checks.
- Locked dependencies, automated dependency update proposals, and documented security reporting.
- Atomic Redis session admission and serialized PostgreSQL IP/device-limit registration under parallel activations.
- SHA-256 license-secret storage with masked administrative listings and a complete legacy backfill that drops plaintext storage.
- Server-issued session tokens bound to their activation IP/device context and explicit atomic named-meter usage ledgers.
- Optional Stripe subscription linking with exact-body signature verification, a durable idempotent webhook inbox, current-state reconciliation, and independent manual/billing revocation.
- Immutable action and container references, fail-closed Compose secrets, localhost-only local port publishing, and automated Docker dependency updates.
- An enforced 80% application-service line-coverage floor plus FOSS governance, issue, pull-request, release, and operations guidance.
- Multiple admin credentials for zero-downtime rotation, dependency URL validation, and probe endpoints that cannot be rate-limited into false failures.
- Release metadata validation that prevents mismatched root, server, changelog, and tag versions.
- Canonical references for CLI commands, HTTP routes, configuration, and licensing rules.

## Required for each production environment

These are deployment evidence, not repository code changes:

1. Configure secret-safe logs, platform metrics, and alert thresholds for the chosen runtime.
2. Exercise the [operations runbook](https://github.com/keyzori/Keyzori/wiki/Operations), including backup restore and migration rollback, against production-sized data.
3. Run load, soak, rate-limit, and dependency-failure tests through the intended TLS proxy and dependency topology.
4. Record recovery objectives, on-call ownership, data retention, privacy obligations, and the exact release image tag.
5. Review the release against the [compatibility and release policy](RELEASE_POLICY.md).

## Per-release checklist

- [ ] Version and changelog are updated.
- [ ] Database migration is reviewed and tested against a recent backup copy.
- [ ] `bun install --frozen-lockfile`, `bun run check`, `bun run build`, and package smoke tests pass.
- [ ] Live PostgreSQL/Redis lifecycle and container build checks pass in CI.
- [ ] Server runtime artifacts contain only intended files and the selected license.
- [ ] Deployment rollback and secret-rotation steps are documented for the release.
- [ ] Images and packages are immutable, checksummed, and traceable to the source tag.
