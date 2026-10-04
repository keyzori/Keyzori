# Changelog

## 2.0.0 (2026-10-04)


### ⚠ BREAKING CHANGES

* v2 replaces the v1 HTTP API, settings, credential formats and database schema. V1 databases require a separate fresh v2 deployment; no in-place upgrade is supported. The console, installable plugins and Stripe integration are not included. Stable deployment support is Linux x64 and ARM64; Windows remains experimental and macOS runtime behaviour is untested. Elysia 2 beta remains a pinned dependency.

### Features

* integrate v2 licensing server into main ([e00df80](https://github.com/keyzori/Keyzori/commit/e00df8031882274ca08c00088afd34eae2af0701))


### Bug Fixes

* restore listener host isolation ([#135](https://github.com/keyzori/Keyzori/issues/135)) ([ba3ba16](https://github.com/keyzori/Keyzori/commit/ba3ba16fc0ce9b586b73103bd83502213fcb8be0))

## Changelog
