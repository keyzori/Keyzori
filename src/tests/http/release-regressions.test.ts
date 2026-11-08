import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TestHttp } from "../fixtures/TestHttp";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { users } from "../../core/database/schema/users";
import { t } from "elysia";
import type { TSchema } from "typebox";
import { groupModel } from "../../plugins/groups/model";
import { userModel } from "../../plugins/users/model";
import { licenseModel } from "../../plugins/licenses/model";
import { validationModel } from "../../plugins/validate/model";
import { settingsModel } from "../../plugins/settings/model";
import { checkedJSON } from "../fixtures/Json";

const settingsResponse = t.Object({ data: settingsModel.value });
const groupResponse = t.Object({ data: groupModel.resource });
const userResponse = t.Object({
	data: userModel.resource,
	meta: t.Object({
		operation: t.Optional(t.Object({ replayed: t.Boolean() })),
	}),
});
const licenseResponse = t.Object({ data: licenseModel.resource });
const issuedLicense = t.Object({
	...licenseModel.resource.properties,
	credential: t.String(),
});
const validationResponse = t.Object({
	data: validationModel.response.properties.data,
});

const context = new TestHttp();

async function settings(changes: Record<string, unknown>) {
	const response = await context.request("/settings", {
		method: "PATCH",
		body: { changes },
	});
	expect(response.status).toBe(200);
	return (await checkedJSON(response, settingsResponse)).data;
}

async function create<const Schema extends TSchema>(
	path: string,
	body: Record<string, unknown>,
	schema: Schema,
) {
	const response = await context.request(path, {
		method: "POST",
		body,
		headers: { "Idempotency-Key": Bun.randomUUIDv7() },
	});
	expect(response.status).toBe(200);
	return checkedJSON(response, t.Object({ data: schema }));
}

const createGroup = (body: Record<string, unknown>) =>
	create("/groups", body, groupModel.resource);
const createLicense = (body: Record<string, unknown>) =>
	create("/licenses", body, issuedLicense);
const rotateLicense = (body: Record<string, unknown>) =>
	create("/licenses/rotate", body, licenseModel.rotated.properties.data);

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

test("settings and group formats reject bearer-incompatible text without persisting it", async () => {
	const before = (
		await checkedJSON(await context.request("/settings"), settingsResponse)
	).data;
	try {
		await settings({ globalFormatEnabled: false });
		const group = await createGroup({ name: "format admission" });
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
					["/groups", "POST", { name: "invalid format", keyFormat }],
					[
						"/groups",
						"PATCH",
						{ ids: [group.data.id], changes: { keyFormat } },
					],
				] as const) {
					const response = await context.request(path, { method, body });
					expect(response.status).toBe(400);
					expect(await response.json()).toMatchObject({
						error: { code: "INVALID_REQUEST" },
					});
				}
			}
		}
		expect(
			(await checkedJSON(await context.request("/settings"), settingsResponse))
				.data.globalKeyFormat,
		).toEqual(before.globalKeyFormat);
		expect(
			(
				await checkedJSON(
					await context.request(`/groups/${group.data.id}`),
					groupResponse,
				)
			).data.keyFormat,
		).toBeNull();
	} finally {
		await settings({
			globalFormatEnabled: before.globalFormatEnabled,
			globalKeyFormat: before.globalKeyFormat,
		});
	}
}, 30000);

test("printable custom formats remain usable after issuance and rotation", async () => {
	const before = (
		await checkedJSON(await context.request("/settings"), settingsResponse)
	).data;
	const format = {
		...KeyGenerator.defaultFormat,
		prefix: " kz ",
		separator: "::",
	};
	try {
		await settings({ globalFormatEnabled: true, globalKeyFormat: format });
		const issued = await createLicense({});
		expect(issued.data.credential.startsWith(" kz ::")).toBe(true);
		await enable("/licenses", issued.data.id);
		const validation = await context.request("/validate", {
			method: "POST",
			credential: null,
			body: { license: issued.data.credential },
		});
		expect((await checkedJSON(validation, validationResponse)).data.code).toBe(
			"VALID",
		);
		const rotated = await rotateLicense({
			ids: [issued.data.id],
		});
		const fresh = await context.request("/validate", {
			method: "POST",
			credential: null,
			body: { license: rotated.data[0]?.credential },
		});
		expect((await checkedJSON(fresh, validationResponse)).data.valid).toBe(
			true,
		);
		const stale = await context.request("/validate", {
			method: "POST",
			credential: null,
			body: { license: issued.data.credential },
		});
		expect((await checkedJSON(stale, validationResponse)).data.code).toBe(
			"LICENSE_INVALID",
		);
		await settings({ globalFormatEnabled: false });
		const group = await createGroup({
			name: "custom group format",
			keyFormat: format,
		});
		await enable("/groups", group.data.id);
		const groupLicense = await createLicense({
			groupId: group.data.id,
		});
		await enable("/licenses", groupLicense.data.id);
		expect(groupLicense.data.credential.startsWith(" kz ::")).toBe(true);
		const groupValidation = await context.request("/validate", {
			method: "POST",
			credential: null,
			body: {
				license: groupLicense.data.credential,
				expectedGroupId: group.data.id,
			},
		});
		expect(
			(await checkedJSON(groupValidation, validationResponse)).data.valid,
		).toBe(true);
	} finally {
		await settings({
			globalFormatEnabled: before.globalFormatEnabled,
			globalKeyFormat: before.globalKeyFormat,
		});
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
	const original = await checkedJSON(first, userResponse);
	const replay = await context.request("/users", {
		method: "POST",
		headers,
		body: { metadata: reordered, name },
	});
	expect(replay.status).toBe(200);
	const replayBody = await checkedJSON(replay, userResponse);
	expect(replayBody.data).toEqual(original.data);
	expect(replayBody.meta.operation?.replayed).toBe(true);
	const changed = await context.request("/users", {
		method: "POST",
		headers,
		body: { name, metadata: { ...reordered, "\u00e9": 2 } },
	});
	expect(changed.status).toBe(409);
	expect(await changed.json()).toMatchObject({
		error: { code: "IDEMPOTENCY_KEY_REUSED" },
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
	const secretReplay = await context.request("/licenses", {
		method: "POST",
		headers: secretHeaders,
		body: { metadata: reordered },
	});
	expect(secretReplay.status).toBe(409);
	const denied = await secretReplay.json();
	expect(denied).toMatchObject({
		error: { code: "SECRET_ALREADY_ISSUED" },
	});
	expect(denied).not.toHaveProperty("credential");
}, 30000);

test("simultaneous reordered Unicode usage requests consume only once", async () => {
	const issued = await createLicense({
		meters: {
			upsert: [
				{ name: "\u00e9", limit: "5" },
				{ name: "e\u0301", limit: "5" },
			],
		},
	});
	await enable("/licenses", issued.data.id);
	const headers = { "Idempotency-Key": Bun.randomUUIDv7() };
	const results = await Promise.all(
		[
			{ "\u00e9": "1", "e\u0301": "2" },
			{ "e\u0301": "2", "\u00e9": "1" },
		].map((usage) =>
			context.request("/licenses/consume", {
				method: "POST",
				headers,
				body: { licenseId: issued.data.id, usage },
			}),
		),
	);
	for (const response of results) {
		expect(response.status).toBe(200);
		expect(
			(await checkedJSON(response, t.Object({ ok: t.Boolean() }))).ok,
		).toBe(true);
	}
	const read = await context.request(`/licenses/${issued.data.id}`);
	expect(read.status).toBe(200);
	const values = (await checkedJSON(read, licenseResponse)).data.meters;
	expect(
		Object.fromEntries(values.map((meter) => [meter.name, meter.value])),
	).toEqual({ "\u00e9": "1", "e\u0301": "2" });
}, 30000);
