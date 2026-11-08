import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { t } from "elysia";
import { TestHttp } from "../fixtures/TestHttp";
import { checkedJSON } from "../fixtures/Json";

const context = new TestHttp();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("operations diagnostics require the master credential and expose only redacted checks", async () => {
	const issued = await checkedJSON(
		await context.request("/api-keys", {
			method: "POST",
			headers: { "Idempotency-Key": Bun.randomUUIDv7() },
			body: { name: "Diagnostics boundary" },
		}),
		t.Object({ data: t.Object({ id: t.String(), credential: t.String() }) }),
	);
	expect(
		(
			await context.request("/api-keys/enable", {
				method: "POST",
				body: { ids: [issued.data.id] },
			})
		).status,
	).toBe(200);
	expect(
		(await context.request("/health/diagnostics", { credential: null })).status,
	).toBe(401);
	expect(
		(
			await context.request("/health/diagnostics", {
				credential: issued.data.credential,
			})
		).status,
	).toBe(403);
	const secret = "postgresql://private:NEVER_EXPOSE@private.invalid/database";
	const ping = spyOn(context.services.database, "ping").mockRejectedValue(
		new Error(secret, { cause: { code: "28P01", detail: secret } }),
	);
	try {
		context.services.health.setPhase("dependencies");
		const response = await context.request("/health/diagnostics");
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('"phase":"dependencies"');
		expect(body).toContain("SQLSTATE_28P01");
		expect(body).not.toContain("NEVER_EXPOSE");
		expect(body).not.toContain(issued.data.credential);
		expect(body).not.toContain(context.master);
		const readiness = await context.request("/health", { credential: null });
		expect(readiness.status).toBe(503);
		const publicBody = await readiness.text();
		expect(publicBody).not.toContain("SQLSTATE");
		expect(publicBody).not.toContain("checks");
		expect((await context.request("/live", { credential: null })).status).toBe(
			200,
		);
	} finally {
		ping.mockRestore();
		context.services.health.setPhase("serving");
	}
});
