# Release artifacts

Release metadata lives only in the root package.json. The container runs TypeScript directly with Bun. There is no code build, dist output, or standalone binary.

CI runs separate typecheck, lint, migration integrity, release metadata, unit-test, Compose, and infrastructure jobs. HTTP, services, database, plugins, and CLI infrastructure suites run independently with PostgreSQL/Redis. The final Docker job depends on every check, builds once, smoke-tests the resulting image, and only then publishes it. Pull requests never publish. Successful main pushes publish canary and commit-tagged containers.

Releases validate an existing tag against main and the manifest, resolve its immutable commit, and run the same checks. The final image job verifies and publishes that exact source, then creates the GitHub release. Prereleases never update latest. Existing promotion/tag preparation remains separate.

Do not call a release successful until its remote publication has completed. This rebuild does not publish or deploy anything automatically from a local development run.
