# Production readiness

Run `bun run check`, the real infrastructure suite with both test URLs, and `bun run docker:smoke`. See the [Deployment](https://github.com/keyzori/keyzori/wiki/Deployment) and [Operations](https://github.com/keyzori/keyzori/wiki/Operations) pages.

Use a fresh database. Validate production proxy trust and real Stripe connectivity separately; local signed-webhook tests do not validate a production account.
