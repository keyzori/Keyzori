import { expect, test } from "bun:test";
import {
	assertOperations,
	operationFor,
	operations,
} from "../../core/http/operations";

test("an unclassified mounted operation fails composition", () => {
	expect(() =>
		assertOperations([{ method: "POST", path: "/new-unguarded-operation" }]),
	).toThrow("Undeclared HTTP operation");
	expect(() =>
		assertOperations([{ method: "GET", path: "/licenses/unguarded-export" }]),
	).toThrow("Undeclared HTTP operation");
	expect(operationFor("DELETE", "/validate")).toBeUndefined();
	expect(operationFor("POST", "/health")).toBeUndefined();
});

test("specific resource operations take precedence over parameterized reads", () => {
	expect(operationFor("GET", "/webhooks/deliveries")?.query).toBe("deliveries");
	expect(operationFor("GET", `/licenses/${Bun.randomUUIDv7()}`)?.access).toBe(
		"licenses:read",
	);
	expect(operationFor("HEAD", "/metrics")?.access).toBe("root");
	expect(
		new Set(operations.map((value) => `${value.method}:${value.path}`)).size,
	).toBe(operations.length);
});
