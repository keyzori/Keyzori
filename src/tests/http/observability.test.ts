import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { TestHttp } from "../fixtures/TestHttp";
import { Replay } from "../../core/security/Replay";

const context = new TestHttp();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("response bugs and SQL programming errors are redacted 500s with correlation", async () => {
	const logs = spyOn(console, "log").mockImplementation(() => {});
	const fault = spyOn(context.services.licenses, "read").mockResolvedValue(
		JSON.parse(
			'{"data":[{"credential":"MUST_NOT_LEAK"}],"pageLimit":50,"nextCursor":null}',
		),
	);
	try {
		for (const [index, path] of [
			"/licenses",
			"/licenses/",
			"/licenses",
		].entries()) {
			if (index === 2)
				fault.mockImplementation(async () => {
					await context.services.database.transaction((tx) =>
						tx.execute(
							sql`select ${"MUST_NOT_LEAK"} from deliberately_missing_table`,
						),
					);
					throw new Error("Expected SQL fixture failure");
				});
			const response = await context.request(path);
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({
				ok: false,
				data: null,
				error: { code: "INTERNAL_ERROR", message: "Internal server error" },
			});
			expect(response.headers.get("x-request-id")).toBeTruthy();
		}
		expect(JSON.stringify(logs.mock.calls)).not.toContain("MUST_NOT_LEAK");
		expect(JSON.stringify(logs.mock.calls)).toContain("schema_validation");
		expect(JSON.stringify(logs.mock.calls)).toContain("SQLSTATE_42P01");
		expect(logs.mock.calls).toHaveLength(3);
	} finally {
		fault.mockRestore();
		logs.mockRestore();
	}
});

test("a retained result must satisfy the same mounted response schema as a fresh result", async () => {
	const fault = spyOn(context.services.groups, "enable").mockRejectedValue(
		new Replay({ data: [{ unexpected: "STORED_MARKER" }] }),
	);
	try {
		const response = await context.request("/groups/enable", {
			method: "POST",
			body: { ids: [Bun.randomUUIDv7()] },
		});
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).toContain("INTERNAL_ERROR");
		expect(text).not.toContain("STORED_MARKER");
	} finally {
		fault.mockRestore();
	}
});

test("metrics preserve statuses and aggregate parameterized routes without identifying resources", async () => {
	const path = `/MUST_NOT_LEAK-${Bun.randomUUIDv7()}`;
	expect((await context.request(path)).status).toBe(404);
	const ids = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
	for (const id of ids)
		expect((await context.request(`/licenses/${id}`)).status).toBe(404);
	const response = await context.request("/metrics");
	const text = await response.text();
	expect(text).toContain('route="unmatched",status="404"');
	expect(text).toContain('route="/licenses/:id",status="404"} 2');
	for (const id of ids) expect(text).not.toContain(id);
	expect(text).not.toContain("MUST_NOT_LEAK");
	expect(text).not.toContain(context.master);
});

test("live dependency loss changes health and validation to unavailable", async () => {
	context.services.redis.close();
	try {
		const health = await context.request("/health", { credential: null });
		expect(health.status).toBe(503);
		expect(await health.json()).toMatchObject({
			ok: false,
			error: { code: "SERVICE_UNAVAILABLE" },
		});
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
