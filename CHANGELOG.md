# Changelog

## [2.0.1](https://github.com/keyzori/Keyzori/compare/v2.0.0...v2.0.1) (2026-10-04)

This patch completes the server-only v2 distribution. The original v2.0.0 GitHub release became immutable before asset upload and has no downloadable binaries or release image. New releases stage all binaries, checksums and verified Linux AMD64/ARM64 images before publishing. Compose and `.env.example` now track the released version automatically.

Stable deployment support is Linux x64 and ARM64. Windows binaries remain experimental: Bun 1.4.2 has crashed during PostgreSQL outage testing, and graceful shutdown is unverified. macOS binaries receive native build and version checks only; runtime behaviour is untested. Elysia 2 beta remains pinned.

V2 replaces the v1 API, settings, credentials and database schema. Back up v1 and deploy v2 with a separate fresh database; no in-place v1 upgrade is supported. The console, installable plugins and Stripe integration are not included. Existing v2 deployments need no database schema changes for this patch.


### Bug Fixes

* **release:** stage immutable release assets before publication ([d705316](https://github.com/keyzori/Keyzori/commit/d705316975e642af213a8d210e43bab643cc2b26))

## 2.0.0 (2026-10-04)


### ⚠ BREAKING CHANGES

* v2 replaces the v1 HTTP API, settings, credential formats and database schema. V1 databases require a separate fresh v2 deployment; no in-place upgrade is supported. The console, installable plugins and Stripe integration are not included. Stable deployment support is Linux x64 and ARM64; Windows remains experimental and macOS runtime behaviour is untested. Elysia 2 beta remains a pinned dependency.

Windows builds are experimental: Bun 1.4.2 has crashed during PostgreSQL outage testing, and graceful shutdown is unverified. macOS binaries receive native build and version checks only. Deploy on Linux x64 or ARM64; both architectures pass the complete 210-test suite and source, binary, container and Compose checks.

### Features

* integrate v2 licensing server into main ([e00df80](https://github.com/keyzori/Keyzori/commit/e00df8031882274ca08c00088afd34eae2af0701))


### Bug Fixes

* restore listener host isolation ([#135](https://github.com/keyzori/Keyzori/issues/135)) ([ba3ba16](https://github.com/keyzori/Keyzori/commit/ba3ba16fc0ce9b586b73103bd83502213fcb8be0))
* refuse v1 and unversioned nonempty databases, or missing/empty v2 migration history, before changing schema or stored data ([#138](https://github.com/keyzori/Keyzori/pull/138))
* verify published server tags share one Linux AMD64/ARM64 image index and retain manifest evidence in the release workflow ([#138](https://github.com/keyzori/Keyzori/pull/138))
