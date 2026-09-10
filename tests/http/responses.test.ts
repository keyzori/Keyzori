import { expect, expectTypeOf, test } from "bun:test";
import { Elysia } from "elysia";
import { customerResponse } from "../../src/customers/responses.ts";
import { pageResponse } from "../../src/shared/responses.ts";

const customersResponse = pageResponse(customerResponse);
const customer = {
	id: "ad05a134-4e1d-46f2-9402-b0b531c59596",
	email: "customer@example.com",
	name: "Customer",
	metadata: {},
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};
const page = { items: [customer], limit: 50, offset: 0, hasMore: false };

test("paginated responses preserve item types and accept async handlers", async () => {
	expectTypeOf<typeof customersResponse.infer>().toEqualTypeOf<{
		items: (typeof customerResponse.infer)[];
		limit: number;
		offset: number;
		hasMore: boolean;
	}>();
	const app = new Elysia().get("/customers", async () => page, {
		response: customersResponse,
	});
	const response = await app.handle(new Request("http://localhost/customers"));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(JSON.parse(JSON.stringify(page)));
});

test("paginated responses retain item and pagination validation", () => {
	expect(customersResponse.allows(page)).toBe(true);
	expect(customersResponse.allows({ ...page, items: [] })).toBe(true);
	for (const invalid of [
		{ ...page, items: [{ ...customer, id: "invalid" }] },
		{ ...page, items: [{ ...customer, createdAt: "2026-01-01" }] },
		{ ...page, items: [{ ...customer, unexpected: true }] },
		{ ...page, limit: 1.5 },
		{ ...page, offset: "0" },
		{ ...page, hasMore: "false" },
	]) {
		expect(customersResponse.allows(invalid)).toBe(false);
	}
});
