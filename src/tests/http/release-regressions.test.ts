import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { TestHttp } from "../fixtures/TestHttp";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { SecretHasher } from "../../core/security/SecretHasher";
import { users } from "../../core/database/schema/users";
import { items } from "../../core/database/schema/items";
import { receipts } from "../../core/database/schema/receipts";

const context = new TestHttp();
const hash = (text: string) =>
	new Bun.CryptoHasher("sha256").update(text).digest("hex");

async function settings(changes: Record<string, unknown>) {
	const response = await context.request("/settings", {
		method: "PATCH",
		body: { changes },
	});
	expect(response.status).toBe(200);
	return (await response.json()).data;
}

async function create(path: string, body: Record<string, unknown>) {
	const response = await context.request(path, {
		method: "POST",
		body,
		headers: { "Idempotency-Key": Bun.randomUUIDv7() },
	});
	expect(response.status).toBe(200);
	return response.json();
}

async function enable(path: string, id: string) {
	const response = await context.request(`${path}/enable`, {
		method: "POST",
		body: { ids: [id] },
	});
	expect(response.status).toBe(200);
}

beforeAll(async () => {
	await context.start();
	await settings({ rateLimitEnabled: false });
});
afterAll(() => context.stop());

test("settings and item formats reject bearer-incompatible text without persisting it", async () => {
	const before = (await (await context.request("/settings")).json()).data;
	try {
		await settings({ globalFormatEnabled: false });
		const item = await create("/items", { name: "format admission" });
		for (const field of ["prefix", "separator"] as const) {
			for (const value of [
				"bad\r\n",
				"\0",
				"\t",
				"\x7f",
				"\u00e9",
				"\u4f60\u597d",
				"\ud83d\ude00",
			]) {
				const keyFormat = { ...KeyGenerator.defaultFormat, [field]: value };
				for (const [path, method, body] of [
					["/settings", "PATCH", { changes: { globalKeyFormat: keyFormat } }],
					["/items", "POST", { name: "invalid format", keyFormat }],
					["/items", "PATCH", { ids: [item.data.id], changes: { keyFormat } }],
				] as const) {
					const response = await context.request(path, { method, body });
					expect(response.status).toBe(400);
					expect(await response.json()).toMatchObject({
						code: "INVALID_REQUEST",
					});
				}
			}
		}
		expect(
			(await (await context.request("/settings")).json()).data.globalKeyFormat,
		).toEqual(before.globalKeyFormat);
		expect(
			(await (await context.request(`/items?id=${item.data.id}`)).json()).data
				.keyFormat,
		).toBeNull();
	} finally {
		await settings({
			globalFormatEnabled: before.globalFormatEnabled,
			globalKeyFormat: before.globalKeyFormat,
		});
	}
}, 30000);

test("printable custom formats remain usable after issuance and rotation", async () => {
	const before = (await (await context.request("/settings")).json()).data;
	const format = {
		...KeyGenerator.defaultFormat,
		prefix: " kz ",
		separator: "::",
	};
	try {
		await settings({ globalFormatEnabled: true, globalKeyFormat: format });
		const issued = await create("/licenses", {});
		expect(issued.credential.startsWith(" kz ::")).toBe(true);
		await enable("/licenses", issued.data.id);
		const self = await context.request("/licenses/self", {
			credential: issued.credential,
		});
		expect(self.status).toBe(200);
		expect((await self.json()).data.id).toBe(issued.data.id);
		const validation = await context.request("/validate", {
			method: "POST",
			credential: null,
			body: { license: issued.credential },
		});
		expect((await validation.json()).code).toBe("VALID");
		const rotated = await create("/licenses/rotate", { ids: [issued.data.id] });
		expect(
			(
				await context.request("/licenses/self", {
					credential: rotated.data[0].credential,
				})
			).status,
		).toBe(200);
		expect(
			(
				await context.request("/licenses/self", {
					credential: issued.credential,
				})
			).status,
		).toBe(401);
		await settings({ globalFormatEnabled: false });
		const item = await create("/items", {
			name: "custom item format",
			keyFormat: format,
		});
		await enable("/items", item.data.id);
		const itemLicense = await create("/licenses", { itemId: item.data.id });
		await enable("/licenses", itemLicense.data.id);
		expect(itemLicense.credential.startsWith(" kz ::")).toBe(true);
		expect(
			(
				await context.request("/licenses/self", {
					credential: itemLicense.credential,
				})
			).status,
		).toBe(200);
	} finally {
		await settings({
			globalFormatEnabled: before.globalFormatEnabled,
			globalKeyFormat: before.globalKeyFormat,
		});
	}
}, 30000);

test("UUID case aliases validate and permit only the license's own resources", async () => {
	const userId = "019943aa-abcd-7000-8000-abcdef123456";
	const itemId = "019943aa-abcd-7000-8000-abcdef123457";
	const otherId = "019943aa-abcd-7000-8000-abcdef123458";
	await context.services.database.orm.insert(users).values({
		id: userId,
		name: "case user",
		enabled: true,
		createdBy: "root",
		updatedBy: "root",
	});
	await context.services.database.orm.insert(items).values({
		id: itemId,
		name: "case item",
		enabled: true,
		createdBy: "root",
		updatedBy: "root",
	});
	const issued = await create("/licenses", {
		userId: userId.toUpperCase(),
		itemId: itemId.toUpperCase(),
	});
	expect(issued.data.userId).toBe(userId);
	expect(issued.data.itemId).toBe(itemId);
	await enable("/licenses", issued.data.id);
	for (const [suppliedUser, suppliedItem] of [
		[userId, itemId],
		[userId.toUpperCase(), itemId.toUpperCase()],
		[userId.toUpperCase(), itemId],
		[userId, itemId.toUpperCase()],
	]) {
		const response = await context.request("/validate", {
			method: "POST",
			credential: null,
			body: {
				license: issued.credential,
				userId: suppliedUser,
				itemId: suppliedItem,
			},
		});
		expect(response.status).toBe(200);
		expect((await response.json()).code).toBe("VALID");
	}
	for (const [path, id] of [
		["/users", userId],
		["/items", itemId],
		["/licenses", issued.data.id],
	] as const) {
		for (const alias of [id, id.toUpperCase()]) {
			const response = await context.request(`${path}?id=${alias}`, {
				credential: issued.credential,
			});
			expect(response.status).toBe(200);
			expect((await response.json()).data.id).toBe(id);
		}
		for (const suffix of [
			"",
			`?id=${otherId.toUpperCase()}`,
			`?id=${id.toUpperCase()}&limit=1`,
		])
			expect(
				(
					await context.request(`${path}${suffix}`, {
						credential: issued.credential,
					})
				).status,
			).toBe(403);
	}
	for (const [field, code] of [
		["userId", "USER_NOT_ALLOWED"],
		["itemId", "ITEM_NOT_ALLOWED"],
	] as const) {
		const response = await context.request("/validate", {
			method: "POST",
			credential: null,
			body: {
				license: issued.credential,
				userId: userId.toUpperCase(),
				itemId: itemId.toUpperCase(),
				[field]: otherId.toUpperCase(),
			},
		});
		expect((await response.json()).code).toBe(code);
	}
	for (const [path, id, code] of [
		["/users", userId, "USER_DISABLED"],
		["/items", itemId, "ITEM_DISABLED"],
	] as const) {
		const disabled = await context.request(`${path}/disable`, {
			method: "POST",
			body: { ids: [id.toUpperCase()] },
		});
		expect(disabled.status).toBe(200);
		const response = await context.request("/validate", {
			method: "POST",
			credential: null,
			body: {
				license: issued.credential,
				userId: userId.toUpperCase(),
				itemId: itemId.toUpperCase(),
			},
		});
		expect((await response.json()).code).toBe(code);
		expect(
			(
				await context.request(`${path}?id=${id.toUpperCase()}`, {
					credential: issued.credential,
				})
			).status,
		).toBe(401);
		await enable(path, id);
	}
}, 30000);

test("Unicode metadata replay survives reordering without returning a secret twice", async () => {
	const metadata = { "\u00e9": 1, "e\u0301": 2, nested: [{ b: 2, a: 1 }] };
	const reordered = { nested: [{ a: 1, b: 2 }], "e\u0301": 2, "\u00e9": 1 };
	const name = `Unicode replay ${Bun.randomUUIDv7()}`;
	const headers = { "Idempotency-Key": Bun.randomUUIDv7() };
	const first = await context.request("/users", {
		method: "POST",
		headers,
		body: { name, metadata },
	});
	expect(first.status).toBe(200);
	const original = await first.json();
	const replay = await context.request("/users", {
		method: "POST",
		headers,
		body: { metadata: reordered, name },
	});
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(original);
	const changed = await context.request("/users", {
		method: "POST",
		headers,
		body: { name, metadata: { ...reordered, "\u00e9": 2 } },
	});
	expect(changed.status).toBe(400);
	expect(await changed.json()).toMatchObject({
		code: "IDEMPOTENCY_KEY_REUSED",
	});
	expect(
		await context.services.database.orm
			.select()
			.from(users)
			.where(eq(users.name, name)),
	).toHaveLength(1);
	const secretHeaders = { "Idempotency-Key": Bun.randomUUIDv7() };
	const issued = await context.request("/licenses", {
		method: "POST",
		headers: secretHeaders,
		body: { metadata },
	});
	expect(issued.status).toBe(200);
	const license = await issued.json();
	const secretReplay = await context.request("/licenses", {
		method: "POST",
		headers: secretHeaders,
		body: { metadata: reordered },
	});
	expect(secretReplay.status).toBe(409);
	const denied = await secretReplay.json();
	expect(denied).toMatchObject({
		code: "SECRET_ALREADY_ISSUED",
		ids: [license.data.id],
	});
	expect(denied).not.toHaveProperty("credential");
}, 30000);

test("simultaneous reordered Unicode usage requests consume only once", async () => {
	const issued = await create("/licenses", {
		meters: {
			upsert: [
				{ name: "\u00e9", limit: 5 },
				{ name: "e\u0301", limit: 5 },
			],
		},
	});
	await enable("/licenses", issued.data.id);
	const headers = { "Idempotency-Key": Bun.randomUUIDv7() };
	const results = await Promise.all(
		[
			{ "\u00e9": 1, "e\u0301": 2 },
			{ "e\u0301": 2, "\u00e9": 1 },
		].map((usage) =>
			context.request("/validate", {
				method: "POST",
				credential: null,
				headers,
				body: { license: issued.credential, usage },
			}),
		),
	);
	for (const response of results) {
		expect(response.status).toBe(200);
		expect((await response.json()).code).toBe("VALID");
	}
	const read = await context.request(`/licenses?id=${issued.data.id}`);
	expect(read.status).toBe(200);
	const values = (await read.json()).data.meters as {
		name: string;
		value: string;
	}[];
	expect(
		Object.fromEntries(values.map((meter) => [meter.name, meter.value])),
	).toEqual({ "\u00e9": "1", "e\u0301": "2" });
}, 30000);

test("pre-fix administrative and usage receipts remain replayable", async () => {
	const headers = { "Idempotency-Key": Bun.randomUUIDv7() };
	const body = { name: "legacy replay", metadata: { B: 2, a: 1 } };
	const first = await context.request("/users", {
		method: "POST",
		headers,
		body,
	});
	expect(first.status).toBe(200);
	const original = await first.json();
	await context.services.database.orm
		.update(receipts)
		.set({
			fingerprint: hash('{"metadata":{"a":1,"B":2},"name":"legacy replay"}'),
		})
		.where(
			and(
				eq(receipts.operation, "user.create"),
				eq(receipts.principalId, "root"),
				eq(receipts.key, headers["Idempotency-Key"]),
			),
		);
	const replay = await context.request("/users", {
		method: "POST",
		headers,
		body,
	});
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(original);
	const issued = await create("/licenses", {
		meters: {
			upsert: [
				{ name: "a", limit: 5 },
				{ name: "B", limit: 5 },
			],
		},
	});
	await enable("/licenses", issued.data.id);
	const usageHeaders = { "Idempotency-Key": Bun.randomUUIDv7() };
	const usageBody = { license: issued.credential, usage: { a: 1, B: 2 } };
	const used = await context.request("/validate", {
		method: "POST",
		credential: null,
		headers: usageHeaders,
		body: usageBody,
	});
	expect((await used.json()).code).toBe("VALID");
	const legacy = JSON.stringify({
		body: { usage: { a: 1, B: 2 } },
		clientIp: "127.0.0.1",
		credentialHash: new SecretHasher().hash(issued.credential),
	});
	await context.services.database.orm
		.update(receipts)
		.set({ fingerprint: hash(legacy) })
		.where(
			and(
				eq(receipts.operation, "validate"),
				eq(receipts.principalId, issued.data.id),
				eq(receipts.key, usageHeaders["Idempotency-Key"]),
			),
		);
	const retried = await context.request("/validate", {
		method: "POST",
		credential: null,
		headers: usageHeaders,
		body: usageBody,
	});
	expect(retried.status).toBe(200);
	expect((await retried.json()).code).toBe("VALID");
	const values = (
		await (await context.request(`/licenses?id=${issued.data.id}`)).json()
	).data.meters as { name: string; value: string }[];
	expect(
		Object.fromEntries(values.map((meter) => [meter.name, meter.value])),
	).toEqual({ a: "1", B: "2" });
}, 30000);

test("the maximum accepted default limit works and out-of-range updates leave it intact", async () => {
	const before = (await (await context.request("/settings")).json()).data;
	try {
		await settings({ defaultPageLimit: 2147483646 });
		for (const path of [
			"/licenses",
			"/users",
			"/items",
			"/api-keys",
			"/webhooks",
		])
			expect((await context.request(path)).status).toBe(200);
		for (const defaultPageLimit of [
			0,
			-1,
			2147483647,
			2147483648,
			1.5,
			null,
			"2147483647",
		]) {
			const response = await context.request("/settings", {
				method: "PATCH",
				body: { changes: { defaultPageLimit } },
			});
			expect(
				response.status,
				`defaultPageLimit=${JSON.stringify(defaultPageLimit)}`,
			).toBe(400);
			expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
		}
		expect(
			(await (await context.request("/settings")).json()).data.defaultPageLimit,
		).toBe(2147483646);
		expect((await context.request("/licenses")).status).toBe(200);
		expect((await context.request("/licenses?limit=10")).status).toBe(200);
		// Preserve the HTTP decoder's existing numeric-string coercion.
		expect((await settings({ defaultPageLimit: "10" })).defaultPageLimit).toBe(
			10,
		);
		expect((await context.request("/licenses")).status).toBe(200);
	} finally {
		await settings({ defaultPageLimit: before.defaultPageLimit });
	}
}, 30000);
