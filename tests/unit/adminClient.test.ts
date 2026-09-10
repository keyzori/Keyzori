import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminClient } from "../../src/cli/AdminClient.ts";
import { jsonInput, segment } from "../../src/cli/input.ts";

const key = "test-only-admin-key-at-least-32-characters";
let server: ReturnType<typeof Bun.serve>;
let client: AdminClient;
let targetRequests = 0;
beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/redirect")
				return Response.redirect(new URL("/target", url), 302);
			if (url.pathname === "/target") targetRequests++;
			if (url.pathname === "/failure")
				return Response.json(
					{ error: { code: "CONFLICT", message: "Already exists." } },
					{ status: 409 },
				);
			if (url.pathname === "/opaque")
				return Response.json({ unexpected: true }, { status: 500 });
			return Response.json({
				method: request.method,
				key: request.headers.get("x-admin-key"),
				query: url.searchParams.get("name"),
				body: request.method === "POST" ? await request.json() : null,
			});
		},
	});
	client = new AdminClient({
		KEYZORI_URL: server.url.origin,
		KEYZORI_ADMIN_KEY: key,
	});
});
afterAll(() => server?.stop(true));
test.each([
	"ftp://localhost",
	"http://user:password@localhost",
	"http://localhost/path",
	"http://localhost?x=1",
	"http://localhost#fragment",
])("rejects unsafe API origin %s", (url) =>
	expect(() => new AdminClient({ KEYZORI_URL: url })).toThrow("HTTP(S) origin"),
);
test("sends the admin key, JSON body, and escaped query to the configured origin", async () => {
	expect(
		await client.request(
			"POST",
			"/echo",
			{ nested: { ok: true } },
			{ name: "a&b=1" },
		),
	).toEqual({
		method: "POST",
		key,
		body: { nested: { ok: true } },
		query: "a&b=1",
	});
});
test.each([
	"http://example.invalid",
	"//example.invalid",
	"/\\example.invalid",
	"relative",
])("rejects escaping path %s", async (path) => {
	await expect(client.request("GET", path)).rejects.toThrow();
});
test("refuses redirects rather than forwarding admin credentials", async () => {
	await expect(client.request("GET", "/redirect")).rejects.toThrow();
	expect(targetRequests).toBe(0);
});
test("preserves API error codes/status and sanitizes unknown error bodies", async () => {
	await expect(client.request("GET", "/failure")).rejects.toMatchObject({
		code: "CONFLICT",
		message: "Already exists.",
		status: 409,
	});
	await expect(client.request("GET", "/opaque")).rejects.toMatchObject({
		code: "HTTP_ERROR",
		message: "Server returned HTTP 500.",
		status: 500,
	});
});
test("missing credentials fail before HTTP", async () => {
	const anonymous = new AdminClient({ KEYZORI_URL: server.url.origin });
	await expect(anonymous.request("GET", "/target")).rejects.toThrow(
		"32 characters",
	);
	expect(targetRequests).toBe(0);
});
test.each(["null", "[]", "true", "123", '"text"', "not-json"])(
	"rejects non-object JSON input %s",
	async (value) => {
		await expect(jsonInput(value)).rejects.toThrow();
	},
);
test("reads exact JSON object input and @file content", async () => {
	const value = { name: 'quoted "text"', nested: [1, true] };
	expect(await jsonInput(JSON.stringify(value))).toEqual(value);
	const dir = await mkdtemp(join(tmpdir(), "keyzori-input-"));
	const file = join(dir, "body.json");
	try {
		await Bun.write(file, JSON.stringify(value));
		expect(await jsonInput(`@${file}`)).toEqual(value);
		await expect(jsonInput(`@${join(dir, "missing.json")}`)).rejects.toThrow();
	} finally {
		await unlink(file);
		await rmdir(dir);
	}
	expect(segment("a/b?#&")).toBe("a%2Fb%3F%23%26");
});
