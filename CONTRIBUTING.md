# Contributing to Keyzori

Thanks for helping improve Keyzori. Bug reports, documentation, tests, and focused code changes are welcome.

## Before opening a change

- Search existing issues and pull requests.
- For large features or architecture changes, open a proposal issue first.
- Never include license keys, admin credentials, customer data, or production logs containing secrets.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development

Install Bun 1.3.14 or newer, PostgreSQL, and Redis. Then:

```powershell
Copy-Item .env.example .env
bun install --frozen-lockfile
bun run db:migrate
bun run check
bun run build
```

Keep changes inside the clean-architecture boundaries documented in [Architecture wiki page](https://github.com/keyzori/Keyzori/wiki/Architecture). Use `bun`, `bunx`, `bun:test`, and Biome; do not add npm, pnpm, yarn, ESLint, or Prettier workflows.

See the [development guide](.github/DEVELOPMENT.md) for repository commands, schema changes, live integration tests, and build artifacts.

## Pull requests

- Keep each pull request focused and explain user-visible behavior.
- Add or update tests for changed behavior.
- Ensure `bun run check` and `bun run build` pass.
- Keep application-service source lines above the enforced 80% threshold with `bun run test:coverage:core`.
- Call out migrations, compatibility changes, and operational risks explicitly.

By contributing, you agree that your contribution may be distributed under the repository's license.
