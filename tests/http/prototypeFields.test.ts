import { describe, expect, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";

describe.skipIf(!integrationAvailable)(
	"reserved top-level request fields",
	() => {
		test("rejects inherited names without mutating a valid customer request", async () => {
			const ctx = await new TestContext().start();
			try {
				for (const key of ["constructor", "__proto__", "toString", "valueOf"]) {
					const body = {
						email: "reserved@example.test",
						name: "Rejected reserved field",
						[key]: { admin: true },
					};
					const response = await ctx.request("/admin/customers", "POST", body);
					expect(response.status).toBe(422);
					expect(response.body.error.code).toBe("VALIDATION_ERROR");
				}
				const list = await ctx.request("/admin/customers");
				expect(list.body.items).toHaveLength(0);
				const query = await ctx.request(
					"/admin/customers?constructor=attacker",
				);
				expect(query.status).toBe(422);
				const valid = await ctx.request("/admin/customers", "POST", {
					email: "valid@example.test",
					name: "Valid metadata",
					metadata: { constructor: "ordinary data" },
				});
				expect(valid.status).toBe(201);
				expect(valid.body.metadata.constructor).toBe("ordinary data");
				const license = await ctx.request("/admin/licenses", "POST", {
					customerId: valid.body.id,
					config: { type: "lifetime", constructor: { admin: true } },
				});
				expect(license.status).toBe(422);
				expect((await ctx.request("/admin/licenses")).body.items).toHaveLength(
					0,
				);
			} finally {
				await ctx.close();
			}
		});
	},
);
