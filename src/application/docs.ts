import type { ElysiaOpenAPIConfig } from "@elysia/openapi";

export const apiDescription = `Self-hosted licensing for your software. Issue licenses, control access, and track usage from one API.

## Start here

1. **Create a customer** with POST /admin/customers/.
2. **Issue a license** with POST /admin/licenses/ and save the returned key. Full keys are shown only when issued or rotated.
3. **Activate your application** with POST /sessions/ using the key and a stable deviceId.
4. **Keep the session alive** with POST /sessions/heartbeat before expiresIn seconds elapse. Deactivate when finished.

For metered licenses, create a meter before submitting usage. Each logical usage event needs its own eventId; reuse it when retrying an uncertain request.

## Authentication

| Request | Credentials |
| --- | --- |
| Administration | X-Admin-Key header. Keep this secret on trusted servers and admin machines. |
| Activation | License key in the JSON body. No admin key or bearer token required. |
| Heartbeat, deactivation, usage | Authorization: Bearer ses_… and X-Device-Id. Use the original device identifier and client IP. |
| Health and documentation | No credentials required. |

Use the authentication control to enter credentials for interactive requests. Requests run against this server and can change real data. Credentials are not persisted by this reference.

## License types

| Type | Configuration | Lifecycle |
| --- | --- | --- |
| lifetime | type only | No time-based expiry; access rules still apply. |
| subscription | expiresAt | Valid until a future ISO timestamp; renewal must extend it. |
| trial | durationSeconds | 1–31,536,000 seconds, beginning at first successful activation. |
| metered | type only | Named meters enforce usage limits. |

New licenses allow one registered device, one registered IP, and one active session. Policy changes advance the license revision and invalidate older sessions. Restoring manual access does not clear blocks from other sources.

## Requests and pagination

Send application/json bodies. Actions with an empty-body schema require {}. Undocumented body and query fields are rejected; metadata is an extensible JSON object, limited to 8,192 serialized characters with sensitive values redacted.

List endpoints use limit (1–100, default 50) and offset (0–1,000,000, default 0). Responses contain items, limit, offset, and hasMore. Advance offset by limit while hasMore is true. Timestamps use ISO 8601; durations and TTLs use seconds.

## Errors and retries

Errors use the shared Error schema: an error object with a stable code and a human-readable message.

| Status | Meaning | Next step |
| --- | --- | --- |
| 400 | Invalid value or business rule | Correct the value or license configuration. |
| 401 | Invalid admin credentials or session | Check the admin key, or reactivate an expired/invalid session. |
| 403 | License access denied | Check blocks, expiry, and allowlists. |
| 404 | Resource missing | Check resource identifiers. |
| 409 | Conflict or capacity exhausted | Check duplicates, registrations, session limits, or meter balance. |
| 422 | Invalid JSON, headers, or schema | Match the documented request, including required headers. |
| 429 | Rate limit reached | Back off before retrying. |
| 503 | Server or dependency unavailable | Retry with backoff. Preserve eventId for usage retries. |

Usage consumption supports idempotent retries. Other mutations, including activation and key rotation, should not be retried blindly after an uncertain response.

## Guides

[First license](https://github.com/keyzori/Keyzori/wiki/Product-Flow) · [Runtime integration](https://github.com/keyzori/Keyzori/wiki/Runtime-Flow) · [Configuration](https://github.com/keyzori/Keyzori/wiki/Configuration)
`;

export const apiTags = [
	{
		name: "Runtime sessions",
		description:
			"Activate, refresh, and release device-bound sessions from your application.",
	},
	{
		name: "Runtime usage",
		description:
			"Consume metered units with a bound session and a retry-safe event identifier.",
	},
	{
		name: "Customers",
		description:
			"Manage the customer records that own licenses. Requires X-Admin-Key.",
	},
	{
		name: "Licenses",
		description:
			"Issue keys and manage license type, ownership, expiry, and manual access. Requires X-Admin-Key.",
	},
	{
		name: "Access controls",
		description:
			"Manage license limits, allowlists, and device/IP registrations. All id parameters in this category identify a license.",
	},
	{
		name: "Session administration",
		description:
			"Inspect and terminate active sessions without exposing bearer tokens. Requires X-Admin-Key.",
	},
	{
		name: "Meters",
		description:
			"Configure named usage counters and limits for metered licenses. Requires X-Admin-Key.",
	},
	{
		name: "Usage history",
		description:
			"Inspect durable consumption receipts and historical totals. Requires X-Admin-Key.",
	},
	{
		name: "Activity",
		description:
			"Search audit events, inspect aggregate counts, and enforce the configured retention period. Requires X-Admin-Key.",
	},
	{
		name: "Health",
		description: "Public probes for process liveness and dependency readiness.",
	},
];

export const apiTagGroups = [
	{ name: "Application runtime", tags: ["Runtime sessions", "Runtime usage"] },
	{
		name: "Administration",
		tags: [
			"Customers",
			"Licenses",
			"Access controls",
			"Session administration",
			"Meters",
			"Usage history",
			"Activity",
		],
	},
	{ name: "Operations", tags: ["Health"] },
];

export const scalarConfig = {
	url: "/openapi.json",
	theme: "none",
	layout: "modern",
	darkMode: true,
	showSidebar: true,
	withDefaultFonts: false,
	showDeveloperTools: "never",
	agent: { disabled: true },
	mcp: { disabled: true },
	persistAuth: false,
	hideClientButton: true,
	defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
	customCss: `
:root {
  --scalar-font: ui-sans-serif, system-ui, sans-serif;
  --scalar-font-code: ui-monospace, Consolas, monospace;
  --scalar-radius: 6px;
  --scalar-radius-lg: 10px;
}
.light-mode {
  color-scheme: light;
  --scalar-color-1: #111111;
  --scalar-color-2: #525252;
  --scalar-color-3: #666666;
  --scalar-color-accent: #111111;
  --scalar-background-1: #ffffff;
  --scalar-background-2: #f5f5f5;
  --scalar-background-3: #ebebeb;
  --scalar-background-accent: #ebebeb;
  --scalar-border-color: #dedede;
  --scalar-button-1: #111111;
  --scalar-button-1-color: #ffffff;
  --scalar-button-1-hover: #333333;
}
.dark-mode {
  color-scheme: dark;
  --scalar-color-1: #f5f5f5;
  --scalar-color-2: #b8b8b8;
  --scalar-color-3: #a3a3a3;
  --scalar-color-accent: #ffffff;
  --scalar-background-1: #0a0a0a;
  --scalar-background-2: #141414;
  --scalar-background-3: #242424;
  --scalar-background-accent: #242424;
  --scalar-border-color: #303030;
  --scalar-button-1: #f5f5f5;
  --scalar-button-1-color: #0a0a0a;
  --scalar-button-1-hover: #d4d4d4;
}
.light-mode, .dark-mode {
  --scalar-color-green: var(--scalar-color-1);
  --scalar-color-red: var(--scalar-color-1);
  --scalar-color-yellow: var(--scalar-color-2);
  --scalar-color-blue: var(--scalar-color-1);
  --scalar-color-orange: var(--scalar-color-2);
  --scalar-color-purple: var(--scalar-color-2);
  --scalar-sidebar-background-1: var(--scalar-background-1);
  --scalar-sidebar-color-1: var(--scalar-color-1);
  --scalar-sidebar-color-2: var(--scalar-color-2);
  --scalar-sidebar-border-color: var(--scalar-border-color);
  --scalar-sidebar-item-hover-background: var(--scalar-background-2);
  --scalar-sidebar-item-hover-color: var(--scalar-color-1);
  --scalar-sidebar-item-active-background: var(--scalar-background-3);
  --scalar-sidebar-color-active: var(--scalar-color-1);
  --scalar-sidebar-search-background: var(--scalar-background-2);
  --scalar-sidebar-search-color: var(--scalar-color-2);
  --scalar-sidebar-search-border-color: var(--scalar-border-color);
}
`,
} satisfies ElysiaOpenAPIConfig["scalar"];
