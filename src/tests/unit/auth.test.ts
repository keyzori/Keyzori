import { describe, expect, test } from "bun:test";
import { TypeBoxValidator } from "elysia";
import { PgDialect } from "drizzle-orm/pg-core";
import { AuthService } from "../../core/auth/AuthService";
import { groups } from "../../core/database/schema/groups";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { apiKeyModel } from "../../plugins/api-keys/model";
import type { $Principal } from "../../types/auth";

const master = new KeyGenerator().master();
let databaseCalls = 0;
const auth = new AuthService(
	{
		transaction: async () => {
			databaseCalls++;
			throw new Error("Unexpected database call");
		},
	},
	master,
);
const selectedGroup = "01933b5a-0000-7000-8000-000000000001";
const selected: $Principal = {
	kind: "api",
	id: "01933b5a-0000-7000-8000-000000000002",
	name: "Selected groups",
	scopes: ["licenses:read"],
	credentialHash: "0".repeat(64),
	allGroups: false,
	groupIds: [selectedGroup],
};

describe("API-key authority", () => {
	test("master authentication does not create or expose an API-key row", async () => {
		expect(await auth.authenticate(`Bearer ${master}`)).toEqual({
			kind: "root",
			id: "root",
			name: "Root",
			scopes: [],
		});
		expect(databaseCalls).toBe(0);
	});

	test("licence credentials and malformed headers do not authenticate management access", async () => {
		for (const header of [
			null,
			"",
			"Basic abc",
			"Bearer KZ-AAAA-BBBB",
			"Bearer ",
			`Bearer ${"a".repeat(4097)}`,
		])
			await expect(auth.authenticate(header)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		expect(databaseCalls).toBe(0);
	});

	test("group selection cannot access another group, ungrouped keys or global operations", () => {
		expect(() => auth.requireGroup(selected, selectedGroup)).not.toThrow();
		expect(() =>
			auth.requireGroup(selected, selectedGroup.toUpperCase()),
		).not.toThrow();
		expect(() => auth.requireGroup(selected, null)).toThrow();
		expect(() => auth.requireGroup(selected, Bun.randomUUIDv7())).toThrow();
		expect(() => auth.requireAllGroups(selected)).toThrow();
		const filter = auth.groupFilter(selected, groups.id);
		if (!filter) throw new Error("Missing selected-group filter");
		const query = new PgDialect().sqlToQuery(filter);
		expect(query.params).toEqual([selectedGroup]);
		const empty = auth.groupFilter({ ...selected, groupIds: [] }, groups.id);
		if (!empty) throw new Error("Missing empty-group filter");
		expect(new PgDialect().sqlToQuery(empty).sql).toBe("false");
	});

	test("all-group access includes ungrouped keys but cannot bypass action grants", () => {
		const all = { ...selected, allGroups: true, groupIds: [] };
		expect(() => auth.requireGroup(all, null)).not.toThrow();
		expect(() => auth.requireAllGroups(all)).not.toThrow();
		expect(auth.groupFilter(all, groups.id)).toBeUndefined();
		expect(() => auth.require(all, "licenses:read")).not.toThrow();
		expect(() => auth.require(all, "licenses:delete")).toThrow();
		expect(() => auth.require(all, "root")).toThrow();
	});

	test("creation accepts fixed fields only; permissions require a separate update", () => {
		const create = new TypeBoxValidator(apiKeyModel.create);
		expect(
			create.Check({ name: "Integration", description: "Development" }),
		).toBe(true);
		for (const fields of [
			{ scopes: [] },
			{ allGroups: true },
			{ groupIds: [selectedGroup] },
			{ metadata: {} },
		])
			expect(create.Check({ name: "Integration", ...fields })).toBe(false);
		const update = new TypeBoxValidator(apiKeyModel.update);
		expect(
			update.Check({
				ids: [selected.id],
				changes: { scopes: ["licenses:read"], groupIds: [selectedGroup] },
			}),
		).toBe(true);
		expect(
			update.Check({
				ids: [selected.id],
				changes: {
					groupIds: Array.from({ length: 101 }, () => Bun.randomUUIDv7()),
				},
			}),
		).toBe(false);
	});
});
