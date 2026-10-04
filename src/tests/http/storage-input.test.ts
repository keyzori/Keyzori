import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { TestHttp } from "../fixtures/TestHttp";

const context = new TestHttp();
beforeAll(async () => {
	await context.start();
	expect(
		(
			await context.request("/settings", {
				method: "PATCH",
				body: { changes: { rateLimitEnabled: false } },
			})
		).status,
	).toBe(200);
});
afterAll(() => context.stop());

async function invalid(response: Response) {
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
}
async function create(path: string, body: unknown) {
	const response = await context.request(path, {
		method: "POST",
		body,
		headers: { "Idempotency-Key": Bun.randomUUIDv7() },
	});
	expect(response.status).toBe(200);
	return response.json();
}
const cursor = (value: unknown) =>
	Buffer.from(
		JSON.stringify({
			id: "019943aa-abcd-7000-8000-abcdef123456",
			value,
			sort: "createdAt",
			direction: "desc",
		}),
	).toString("base64url");

test("malformed IDs, calendar dates and cursor timestamps consistently return 400", async () => {
	const malformed: Record<string, string>[] = [
		{ id: "" },
		{ createdBefore: "2026-02-30T00:00:00Z" },
		{ createdAfter: "0000-01-01T00:00:00Z" },
		{ createdBefore: "2026-10-01T00:00:00+23:00" },
		{ cursor: cursor("2026-02-30T00:00:00Z") },
		{ cursor: cursor("0000-01-01T00:00:00Z") },
		{ cursor: cursor("2026-10-01") },
	];
	for (const path of [
		"/users",
		"/items",
		"/licenses",
		"/api-keys",
		"/webhooks",
		"/webhooks/deliveries",
	]) {
		for (const params of malformed)
			await invalid(
				await context.request(`${path}?${new URLSearchParams(params)}`),
			);
		expect(
			(
				await context.request(
					`${path}?${new URLSearchParams({ createdBefore: "2024-02-29T00:00:00+05:30" })}`,
				)
			).status,
		).toBe(200);
	}
}, 30000);

test("date filters preserve fractional precision and expiry writes reject unsupported instants", async () => {
	const user = await create("/users", { name: "fractional timestamp" });
	await context.services.database.orm.execute(
		sql`update users set created_at = '2026-10-01T00:00:00.123456Z'::timestamptz where id = ${user.data.id}`,
	);
	for (const [cutoff, expected] of [
		[".123455", 0],
		[".123456", 0],
		[".123457", 1],
	] as const) {
		const response = await context.request(
			`/users?${new URLSearchParams({ search: user.data.id, createdBefore: `2026-10-01T00:00:00${cutoff}Z` })}`,
		);
		expect(response.status).toBe(200);
		expect((await response.json()).data).toHaveLength(expected);
	}
	for (const path of ["/licenses", "/api-keys"]) {
		const base =
			path === "/api-keys" ? { name: "expiry boundary", scopes: [] } : {};
		const existing = await create(path, { ...base, expiresAt: null });
		for (const expiresAt of [
			"0000-01-01T00:00:00Z",
			"2026-02-30T00:00:00Z",
			"2026-10-01T23:59:60Z",
			"9999-12-31T23:59:59-01:00",
		]) {
			await invalid(
				await context.request(path, {
					method: "POST",
					body: { ...base, expiresAt },
					headers: { "Idempotency-Key": Bun.randomUUIDv7() },
				}),
			);
			await invalid(
				await context.request(path, {
					method: "PATCH",
					body: { ids: [existing.data.id], changes: { expiresAt } },
				}),
			);
		}
		expect(
			(await (await context.request(`${path}?id=${existing.data.id}`)).json())
				.data.expiresAt,
		).toBeNull();
		const valid = await create(path, {
			...base,
			expiresAt: "2024-02-29T12:30:00+05:30",
		});
		expect(valid.data.expiresAt).toBe("2024-02-29T07:00:00.000Z");
	}
}, 30000);

test("numeric filters reject PostgreSQL overflow while retaining exact comparison values", async () => {
	const zero = await create("/users", {
		name: "numeric zero",
		metadata: { cost: 0 },
	});
	const exact = await create("/users", {
		name: "numeric integer",
		metadata: { cost: 9007199254740992 },
	});
	for (const value of [
		"1e-16384",
		"1e-1000000",
		"0e-1000000",
		"0e99999999999999999999",
		"1e309",
	])
		await invalid(
			await context.request(
				`/users?${new URLSearchParams({ "metadataNumber.cost": value })}`,
			),
		);
	for (const [value, ids] of [
		["0", [zero.data.id]],
		["0e-16383", [zero.data.id]],
		["1e-16383", []],
		["9007199254740993", []],
		["9007199254740992", [exact.data.id]],
	] as const) {
		const response = await context.request(
			`/users?${new URLSearchParams({ "metadataNumber.cost": value })}`,
		);
		expect(response.status, value).toBe(200);
		expect(
			(await response.json()).data.map((row: { id: string }) => row.id),
			value,
		).toEqual(ids);
	}
}, 30000);

test("invalid text cannot create resources, alter parents, consume usage or leave receipts and audits", async () => {
	const user = await create("/users", { name: "unchanged parent" });
	const license = await create("/licenses", {
		deviceLimit: 1,
		meters: { upsert: [{ name: "requests", limit: 2 }] },
	});
	expect(
		(
			await context.request("/licenses/enable", {
				method: "POST",
				body: { ids: [license.data.id] },
			})
		).status,
	).toBe(200);
	const counts = async () =>
		(
			await context.services.database.orm.execute(sql`select
		(select count(*)::integer from users) as users,
		(select count(*)::integer from licenses) as licenses,
		(select count(*)::integer from audit_logs) as audits,
		(select count(*)::integer from idempotency_receipts) as receipts`)
		)[0];
	const before = await counts();
	for (const bad of ["prefix\0suffix", "\ud800", "\udfff"]) {
		for (const path of ["/users", "/items", "/api-keys"])
			await invalid(
				await context.request(path, {
					method: "POST",
					body:
						path === "/api-keys" ? { name: bad, scopes: [] } : { name: bad },
					headers: { "Idempotency-Key": Bun.randomUUIDv7() },
				}),
			);
		for (const body of [
			{ ids: [user.data.id], changes: { name: bad } },
			{ ids: [user.data.id], changes: { notes: bad } },
			{
				ids: [user.data.id],
				changes: { name: "should roll back" },
				reason: bad,
			},
		])
			await invalid(await context.request("/users", { method: "PATCH", body }));
		await invalid(
			await context.request("/users/disable", {
				method: "POST",
				body: { ids: [user.data.id], disabledReason: bad },
			}),
		);
		await invalid(
			await context.request("/licenses", {
				method: "POST",
				body: { meters: { upsert: [{ name: bad, limit: 1 }] } },
				headers: { "Idempotency-Key": Bun.randomUUIDv7() },
			}),
		);
		await invalid(
			await context.request("/validate", {
				method: "POST",
				credential: null,
				body: {
					license: license.credential,
					hardwareId: bad,
					usage: { requests: 1 },
				},
				headers: { "Idempotency-Key": Bun.randomUUIDv7() },
			}),
		);
		await invalid(
			await context.request("/validate", {
				method: "POST",
				credential: null,
				body: {
					license: license.credential,
					hardwareId: "valid device",
					usage: { [bad]: 1 },
				},
				headers: { "Idempotency-Key": Bun.randomUUIDv7() },
			}),
		);
		await expect(
			context.services.users.create(
				{ name: bad },
				{
					principal: { kind: "root", id: "root", name: "Root", scopes: [] },
					requestId: Bun.randomUUIDv7(),
					clientIp: "127.0.0.1",
				},
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await expect(
			context.services.validation.validate(
				{ license: license.credential, hardwareId: bad },
				{ requestId: Bun.randomUUIDv7(), clientIp: "127.0.0.1" },
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	}
	expect(await counts()).toEqual(before);
	expect(
		(await (await context.request(`/users?id=${user.data.id}`)).json()).data
			.name,
	).toBe("unchanged parent");
	const unchanged = (
		await (await context.request(`/licenses?id=${license.data.id}`)).json()
	).data;
	expect(unchanged.hardwareIds).toEqual([]);
	expect(unchanged.meters[0].value).toBe("0");
}, 30000);

test("query text and malformed UTF-8 fail safely while ordinary Unicode stays intact", async () => {
	const malformed: Record<string, string>[] = [
		{ search: "a\0b" },
		{ "metadata.x": "a\0b" },
		{ "metadata.a\0b": "value" },
	];
	for (const params of malformed)
		await invalid(
			await context.request(`/users?${new URLSearchParams(params)}`),
		);
	const invalidUtf8 = Buffer.concat([
		Buffer.from('{"name":"'),
		Buffer.from([0xc3, 0x28]),
		Buffer.from('"}'),
	]);
	await invalid(
		await fetch(new URL("/users", context.app.server?.url), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${context.master}`,
				"Content-Type": "application/json",
			},
			body: invalidUtf8,
		}),
	);
	const name = "é e\u0301 中文 😀";
	const created = await create("/users", {
		name,
		notes: "line one\nline two\tend",
		metadata: { [name]: [name] },
	});
	expect(created.data.name).toBe(name);
	const response = await context.request(
		`/users?${new URLSearchParams({ search: name })}`,
	);
	expect(response.status).toBe(200);
	expect(
		(await response.json()).data.map((row: { id: string }) => row.id),
	).toContain(created.data.id);
	expect((await context.request("/health", { credential: null })).status).toBe(
		200,
	);
}, 30000);
