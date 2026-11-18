// Readiness pays up to 2 s for peer admission, then probes both dependencies in parallel.
// Leave headroom inside the image's 5 s healthcheck timeout for the CLI and HTTP.
export const healthBudgets = {
	cacheMs: 1000,
	probeMs: 1500,
	cliMs: 4000,
} as const;
