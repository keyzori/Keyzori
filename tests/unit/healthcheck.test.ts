import { expect, test } from "bun:test";
import { healthcheckUrl } from "../../src/main.ts";

test.each([
	["0.0.0.0", "http://0.0.0.0:6284"],
	["127.0.0.1", "http://127.0.0.1:6284"],
	["::", "http://[::]:6284"],
	["::1", "http://[::1]:6284"],
	["2001:db8::1", "http://[2001:db8::1]:6284"],
])("formats a healthcheck URL for %s", (host, url) => {
	expect(healthcheckUrl({ host, port: 6284 })).toBe(url);
});

test.each(["127.0.0.1", "::1"])("probes a listener on %s", async (host) => {
	const server = Bun.serve({
		hostname: host,
		port: 0,
		fetch: () => new Response(null, { status: 200 }),
	});
	try {
		if (server.port === undefined) throw new Error("Listener has no port.");
		const response = await fetch(
			new URL("/ready", healthcheckUrl({ host, port: server.port })),
		);
		expect(response.ok).toBe(true);
	} finally {
		server.stop(true);
	}
});
