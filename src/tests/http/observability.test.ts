import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { t } from "elysia";
import { sql } from "drizzle-orm";
import { TestHttp } from "../fixtures/TestHttp";

const context = new TestHttp();
context.app.get(
	"/broken-response",
	{
		response: t.Object(
			{ expected: t.String() },
			{ additionalProperties: false },
		),
	},
	() => JSON.parse('{"credential":"MUST_NOT_LEAK"}'),
);
context.app.get("/broken-sql", () =>
	context.services.database.transaction((tx) =>
		tx.execute(sql`select ${"MUST_NOT_LEAK"} from deliberately_missing_table`),
	),
);
beforeAll(() => context.start());
afterAll(() => context.stop());

test("response bugs and SQL programming errors are redacted 500s with correlation", async () => {
	const logs = spyOn(console, "log").mockImplementation(() => {});
	try {
		for (const path of ["/broken-response", "/broken-sql"]) {
			const response = await context.request(path);
			expect(response.status).toBe(500);
			expect(await response.text()).toBe(
				'{"code":"INTERNAL_ERROR","reason":"Internal server error"}',
			);
			expect(response.headers.get("x-request-id")).toBeTruthy();
		}
		expect(JSON.stringify(logs.mock.calls)).not.toContain("MUST_NOT_LEAK");
		expect(logs.mock.calls).toHaveLength(2);
	} finally {
		logs.mockRestore();
	}
});

test("metrics preserve statuses and bound attacker-controlled paths", async () => {
	const path = `/MUST_NOT_LEAK-${Bun.randomUUIDv7()}`;
	expect((await context.request(path)).status).toBe(404);
	const response = await context.request("/metrics");
	const text = await response.text();
	expect(text).toContain('route="unmatched",status="404"');
	expect(text).not.toContain("MUST_NOT_LEAK");
	expect(text).not.toContain(context.master);
});

test("live dependency loss changes health and validation to unavailable", async () => {
	context.services.redis.close();
	try {
		const health = await context.request("/health", { credential: null });
		expect(health.status).toBe(503);
		expect(await health.json()).toMatchObject({ healthy: false, redis: false });
		expect(
			(
				await context.request("/validate", {
					method: "POST",
					body: { license: "MUST_NOT_LEAK" },
					credential: null,
				})
			).status,
		).toBe(503);
	} finally {
		await context.services.redis.connect();
	}
	expect((await context.request("/health", { credential: null })).status).toBe(
		200,
	);
});
