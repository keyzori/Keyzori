# Release policy

Release metadata lives only in the root package.json. The container runs TypeScript directly with Bun. There is no code build, dist output, or standalone binary.

CI runs separate typecheck, lint, migration integrity, release metadata, unit-test, Compose, and infrastructure jobs. HTTP, services, database, plugins, and CLI infrastructure suites run independently with PostgreSQL/Redis. The final Docker job depends on every check, builds once, smoke-tests the resulting image, and only then publishes it. Pull requests never publish. Successful main pushes publish canary and commit-tagged containers.

Release Please runs only after both CI and CodeQL have completed successfully for the same main commit. It maintains one release pull request from conventional commits. Merging that pull request updates package.json and CHANGELOG.md, creates the matching vX.Y.Z tag, and publishes the GitHub Release. It does not publish an npm package or container image.

The workflow uses the RELEASE_TOKEN secret because the organization does not allow the built-in GitHub Actions token to create pull requests. Give the fine-grained token Contents, Issues, and Pull requests read/write access to this repository.

Do not call a release successful until the GitHub Release exists. Nothing is published or deployed from a local development run.
