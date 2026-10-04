import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TestHttp } from "../fixtures/TestHttp";
import type { $Metadata } from "../../types/metadata";
import type { $Operation } from "../../types/operation";

const context = new TestHttp();
const operation = (): $Operation => ({
	principal: { kind: "root", id: "root", name: "Root", scopes: [] },
	requestId: Bun.randomUUIDv7(),
	clientIp: "127.0.0.1",
	idempotencyKey: Bun.randomUUIDv7(),
});
beforeAll(async () => {
	await context.start();
	const root = operation();
	await context.services.settings.update(
		{ rateLimitEnabled: false },
		root.principal,
		root,
	);
});
afterAll(() => context.stop());

describe("recursive metadata HTTP and persistence", () => {
	for (const resource of ["items", "users", "licenses"]) {
		test(`${resource} create, read and replace retain nested JSON`, async () => {
			const metadata = {
				plan: "pro",
				seats: 2,
				nested: {
					array: ["a", 3, false, null, { children: [{ enabled: true }] }],
					empty: {},
					"line\nbreak": { unicode: "😀" },
					"constructor\n": true,
				},
			};
			const created = await context.request(`/${resource}`, {
				method: "POST",
				body: {
					...(resource === "licenses" ? {} : { name: "Nested metadata" }),
					metadata,
				},
				headers: { "Idempotency-Key": Bun.randomUUIDv7() },
			});
			expect(created.status).toBe(200);
			const result = await created.json();
			expect(result.data.metadata).toEqual(metadata);
			const read = await context.request(`/${resource}?id=${result.data.id}`);
			expect(read.status).toBe(200);
			expect((await read.json()).data.metadata).toEqual(metadata);
			const replacement = {
				replacement: [{ deep: { active: false, missing: null } }],
			};
			const updated = await context.request(`/${resource}`, {
				method: "PATCH",
				body: { ids: [result.data.id], changes: { metadata: replacement } },
			});
			expect(updated.status).toBe(200);
			const reread = await context.request(`/${resource}?id=${result.data.id}`);
			expect((await reread.json()).data.metadata).toEqual(replacement);
		});
	}
	test("typed scalar filters remain top-level and literal", async () => {
		const metadata = {
			plan: "pro",
			seats: 2,
			enabled: true,
			missing: null,
			nested: { plan: "deep" },
			"nested.plan": "literal",
		};
		const created = await context.request("/items", {
			method: "POST",
			body: { name: "Filtering", metadata },
		});
		expect(created.status).toBe(200);
		const id = (await created.json()).data.id;
		for (const [key, value, matches] of [
			["metadata.plan", "pro", true],
			["metadataNumber.seats", "2", true],
			["metadata.seats", "2", false],
			["metadata.enabled", "true", false],
			["metadata.missing", "null", false],
			["metadata.nested.plan", "deep", false],
			["metadata.nested.plan", "literal", true],
			["metadata.nested", '{"plan":"deep"}', false],
		] as const) {
			const response = await context.request(
				`/items?${new URLSearchParams({ [key]: value })}`,
			);
			expect(response.status).toBe(200);
			const rows = (await response.json()).data as { id: string }[];
			expect(rows.some((row) => row.id === id)).toBe(matches);
		}
	});
	test("unsafe keys are rejected on create and update without changing stored metadata", async () => {
		for (const resource of ["items", "users", "licenses"]) {
			const created = await context.request(`/${resource}`, {
				method: "POST",
				body: {
					...(resource === "licenses" ? {} : { name: "Protected" }),
					metadata: { preserved: true },
				},
				headers: { "Idempotency-Key": Bun.randomUUIDv7() },
			});
			expect(created.status).toBe(200);
			const id = (await created.json()).data.id;
			for (const key of ["__proto__", "constructor", "prototype"]) {
				const metadata = JSON.parse(
					`{"nested":[{"${key}":{"injected":true}}]}`,
				);
				for (const method of ["POST", "PATCH"]) {
					const response = await context.request(`/${resource}`, {
						method,
						body:
							method === "POST"
								? {
										...(resource === "licenses" ? {} : { name: "Invalid" }),
										metadata,
									}
								: { ids: [id], changes: { metadata } },
						headers: { "Idempotency-Key": Bun.randomUUIDv7() },
					});
					expect(response.status).toBe(400);
					expect(await response.json()).toMatchObject({
						code: "INVALID_REQUEST",
					});
				}
			}
			const read = await context.request(`/${resource}?id=${id}`);
			expect((await read.json()).data.metadata).toEqual({ preserved: true });
		}
	});
	test("extreme nesting is rejected before recursive schema evaluation", async () => {
		const response = await fetch(new URL("/items", context.app.server?.url), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${context.master}`,
				"Content-Type": "application/json",
			},
			body: `{"name":"Deep","metadata":${'{"child":'.repeat(10000)}true${"}".repeat(10000)}}`,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
	});
	test("invalid JSONB text is rejected before reaching storage", async () => {
		for (const text of ["\0", "\ud800", "\udfff"]) {
			for (const metadata of [
				{ nested: { value: text } },
				{ nested: { [text]: true } },
			]) {
				const response = await context.request("/items", {
					method: "POST",
					body: { name: "Invalid text", metadata },
				});
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({
					code: "INVALID_REQUEST",
				});
			}
		}
	});
	test("service calls enforce metadata bounds independently of HTTP", async () => {
		let deep: $Metadata = { value: true };
		for (let index = 0; index < 16; index++) deep = { nested: deep };
		for (const metadata of [
			deep,
			JSON.parse('{"safe":{"prototype":false}}'),
			{ values: Array(257).fill(true) },
		]) {
			await expect(
				context.services.items.create(
					{ name: "Invalid service", metadata },
					operation(),
				),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
			await expect(
				context.services.users.create(
					{ name: "Invalid service", metadata },
					operation(),
				),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
			await expect(
				context.services.licenses.create({ metadata }, operation()),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		}
	});
});
