import { expect, test } from "bun:test";
import { healthcheckUrl } from "../../core/http/healthcheckUrl";

test.each([
	["0.0.0.0", "http://127.0.0.1:6284/health"],
	["127.0.0.1", "http://127.0.0.1:6284/health"],
	["127.0.0.2", "http://127.0.0.2:6284/health"],
	["::", "http://[::1]:6284/health"],
	["::1", "http://[::1]:6284/health"],
	["2001:db8::1", "http://[2001:db8::1]:6284/health"],
])("formats a v2 healthcheck URL for %s", (host, url) => {
	expect(healthcheckUrl({ host, port: 6284 })).toBe(url);
});

test.each(["", "localhost", "127.0.0.1:6284", "fe80::1%eth0"])(
	"rejects invalid healthcheck host %s",
	(host) =>
		expect(() => healthcheckUrl({ host, port: 6284 })).toThrow("KZ_API_HOST"),
);

test.each([0, -1, 65536, 1.5, Number.NaN])(
	"rejects invalid healthcheck port %s",
	(port) =>
		expect(() => healthcheckUrl({ host: "127.0.0.1", port })).toThrow(
			"KZ_API_PORT",
		),
);

test.each(["127.0.0.1", "127.0.0.2", "::1"])(
	"healthcheck command probes the configured listener and port on %s",
	async (host) => {
		const server = Bun.serve({
			hostname: host,
			port: 0,
			fetch: (request) =>
				new Response(null, {
					status: new URL(request.url).pathname === "/health" ? 200 : 404,
				}),
		});
		try {
			const child = Bun.spawn(
				[process.execPath, "src/main.ts", "healthcheck"],
				{
					env: {
						...Bun.env,
						KZ_API_HOST: host,
						KZ_API_PORT: String(server.port),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(await child.exited).toBe(0);
			expect(await new Response(child.stderr).text()).toBe("");
		} finally {
			server.stop(true);
		}
	},
);

test("healthcheck command refuses HTTP redirects", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1:1/health" },
			}),
	});
	try {
		const child = Bun.spawn([process.execPath, "src/main.ts", "healthcheck"], {
			env: {
				...Bun.env,
				KZ_API_HOST: "127.0.0.1",
				KZ_API_PORT: String(server.port),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await child.exited).toBe(1);
	} finally {
		server.stop(true);
	}
});
