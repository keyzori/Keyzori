# Changelog

## [3.0.0-beta.2](https://github.com/keyzori/Keyzori/compare/v3.0.0-beta.1...v3.0.0-beta.2) (2026-11-08)


### ⚠ BREAKING CHANGES

* v2 replaces the v1 HTTP API, settings, credential formats and database schema. V1 databases require a separate fresh v2 deployment; no in-place upgrade is supported. The console, installable plugins and Stripe integration are not included. Stable deployment support is Linux x64 and ARM64; Windows remains experimental and macOS runtime behaviour is untested. Elysia 2 beta remains a pinned dependency.

### Features

* integrate v2 licensing server into main ([e00df80](https://github.com/keyzori/Keyzori/commit/e00df8031882274ca08c00088afd34eae2af0701))


### Bug Fixes

* handle auth edge cases and refresh bun workflows ([#143](https://github.com/keyzori/Keyzori/issues/143)) ([6bf99c1](https://github.com/keyzori/Keyzori/commit/6bf99c17ded544b42b236d4255de57ea29acc081))
* **release:** locate staged drafts through the release list ([c0f60fd](https://github.com/keyzori/Keyzori/commit/c0f60fd43495ca649e641d5873493e058aec9666))
* **release:** stage immutable release assets before publication ([d705316](https://github.com/keyzori/Keyzori/commit/d705316975e642af213a8d210e43bab643cc2b26))
* restore listener host isolation ([#135](https://github.com/keyzori/Keyzori/issues/135)) ([ba3ba16](https://github.com/keyzori/Keyzori/commit/ba3ba16fc0ce9b586b73103bd83502213fcb8be0))

## 3.0.0-beta.1 (unreleased)

### Breaking changes

- Redesign the beta API and database schema around optional groups and users. Groups are neutral key containers; deleting a group retains and disables its keys, while deleting a user deletes their keys.
- Make licence-key-only validation return key/group/user/metadata/usage data and raw registered identities while excluding administrative notes recursively. Add expected-group checks and custom disabled reasons. Validation no longer consumes usage or registers devices/IPs.
- Separate exact atomic consumption and registration into authorised endpoints. Consumption requires an API key, retains permanent retry identities and provides separately authorised historical lookup; administrative idempotency receipts have an independent default 24-hour window. Named counters distinguish consumption `startsAt` from calendar `anchorAt`, with stable definition/period/reset identities.
- Introduce a consistent typed response/error/pagination contract and explicit resource detail paths; collection responses always contain arrays. New API keys start disabled with no grants; the environment master alone manages API-key permissions and operational settings. Group restrictions apply across administration, historical receipts, streams and webhooks.
- Add typed, versioned WebSocket event replay, snapshot watermarks and authorised audit access. Separate audit evidence, integration events and operational logs. Retain audit/accepted-usage identity independently of entity deletion; event retention and restore epochs have an explicit resynchronization protocol.
- Replace webhook delivery with encrypted signing secrets, HMAC signatures, bounded retries, owner-authority checks, public-HTTPS egress validation and delivery history.
- Run TypeScript source with the pinned Bun runtime. Use separate explicit migration and runtime roles; serving verifies exact schema history without modifying it. Remove compiled-application build/release machinery.
- Bound request admission, cascade work, event streams, webhook backlogs, background retries and fixture subprocesses. Keep exact arithmetic, transactional writes, secure credentials, trusted-proxy handling and fail-closed dependencies.

V3 is beta. Incompatible databases are refused without resetting or deleting their data. The developer and implementation guides describe the resulting contract; no compatibility layer or in-place data conversion is supplied.

## Historical releases

The entries below describe past releases, not current deployment instructions or verification results.

### [2.0.3](https://github.com/keyzori/Keyzori/compare/v2.0.2...v2.0.3) (2026-10-22)

- Handle authentication edge cases and refresh Bun workflows ([#143](https://github.com/keyzori/Keyzori/issues/143), [6bf99c1](https://github.com/keyzori/Keyzori/commit/6bf99c17ded544b42b236d4255de57ea29acc081)).

### [2.0.2](https://github.com/keyzori/Keyzori/compare/v2.0.1...v2.0.2) (2026-10-04)

- Locate staged drafts through the release list ([c0f60fd](https://github.com/keyzori/Keyzori/commit/c0f60fd43495ca649e641d5873493e058aec9666)).

### [2.0.1](https://github.com/keyzori/Keyzori/compare/v2.0.0...v2.0.1) (2026-10-04)

- Stage immutable release assets before publication ([d705316](https://github.com/keyzori/Keyzori/commit/d705316975e642af213a8d210e43bab643cc2b26)).

### 2.0.0 (2026-10-04)

- Replace the previous API, settings, credentials and database schema with the v2 service ([e00df80](https://github.com/keyzori/Keyzori/commit/e00df8031882274ca08c00088afd34eae2af0701)).
- Restore listener host isolation ([#135](https://github.com/keyzori/Keyzori/issues/135), [ba3ba16](https://github.com/keyzori/Keyzori/commit/ba3ba16fc0ce9b586b73103bd83502213fcb8be0)).
- Refuse incompatible or unversioned databases before changing stored data, and verify published multi-platform image identity ([#138](https://github.com/keyzori/Keyzori/pull/138)).
