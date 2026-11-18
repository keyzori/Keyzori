import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { t } from "elysia";
import { audits } from "../../core/database/schema/audits";
import { httpModel } from "../../core/http/model";
import { licenseModel } from "../../plugins/licenses/model";
import { TestHttp } from "../fixtures/TestHttp";
import { checkedJSON } from "../fixtures/Json";

const context = new TestHttp();
const identity = t.Object({ data: t.Object({ id: httpModel.id }) });
const issuance = t.Object({
	data: t.Object({ id: httpModel.id, credential: t.String() }),
});
const key = () => ({ "Idempotency-Key": Bun.randomUUIDv7() });
beforeAll(() => context.start());
afterAll(() => context.stop());

test("HTTP meter decoding preserves partial decimal edits and requires explicit adjustment and schedule intent", async () => {
	const name = "service\ncredits";
	const response = await context.request("/licenses", {
		method: "POST",
		headers: key(),
		body: {
			meters: {
				upsert: [{ name, numericMode: "decimal", precision: 2, limit: "10" }],
			},
		},
	});
	expect(response.status).toBe(200);
	const { id } = (await checkedJSON(response, issuance)).data;
	const ids = [id];
	expect(
		(
			await context.request("/licenses/enable", {
				method: "POST",
				body: { ids },
			})
		).status,
	).toBe(200);
	const consumed = await context.request("/licenses/consume", {
		method: "POST",
		headers: key(),
		body: { licenseId: id, usage: { [name]: "1.25" } },
	});
	expect(consumed.status).toBe(200);
	const records = () =>
		context.services.database.orm
			.select({ id: audits.id })
			.from(audits)
			.where(eq(audits.targetId, id));
	const before = await records();
	for (const [path, method, body] of [
		["/licenses/meters/adjust", "POST", { ids, name, value: "8" }],
		[
			"/licenses",
			"PATCH",
			{
				ids,
				changes: {
					meters: { upsert: [{ name, schedule: { time: "00:00" } }] },
				},
			},
		],
		[
			"/licenses",
			"PATCH",
			{ ids, changes: { expiresAt: "2029-01-01T00:00:00.1234Z" } },
		],
		[
			"/licenses",
			"PATCH",
			{
				ids,
				changes: {
					meters: { upsert: [{ name, startsAt: "2029-01-01T00:00:00.0001Z" }] },
				},
			},
		],
	] as const) {
		expect((await context.request(path, { method, body })).status).toBe(400);
	}
	expect(await records()).toHaveLength(before.length);
	const patch = (changes: unknown) =>
		context.request("/licenses", { method: "PATCH", body: { ids, changes } });
	expect(
		(
			await patch({
				meters: { upsert: [{ name, limit: "20" }] },
				expiresAt: "2029-01-01T00:00:00+01:00",
				allowedIps: ["2001:0db8:0:0:0:0:0:1"],
			})
		).status,
	).toBe(200);
	const changed = await records();
	expect(
		(
			await patch({
				expiresAt: "2028-12-31T23:00:00Z",
				allowedIps: ["2001:0db8:0:0:0:0:0:1"],
			})
		).status,
	).toBe(200);
	expect(await records()).toHaveLength(changed.length);
	const detail = await checkedJSON(
		await context.request(`/licenses/${id}`),
		t.Object({ data: licenseModel.resource }),
	);
	expect(detail.data.meters[0]).toMatchObject({
		name,
		numericMode: "decimal",
		precision: 2,
		limit: "20",
		value: "1.25",
	});
});

test("write-only callers receive identities; read revocation also projects retained parent receipts", async () => {
	const issued = await context.request("/api-keys", {
		method: "POST",
		body: { name: "Provisioner" },
		headers: key(),
	});
	const api = (await checkedJSON(issued, issuance)).data;
	const writes = [
		"groups:create",
		"groups:update",
		"groups:disable",
		"groups:enable",
		"users:create",
		"users:update",
		"users:disable",
		"users:enable",
		"licenses:create",
	];
	const grants = (scopes: string[]) =>
		context.request("/api-keys", {
			method: "PATCH",
			body: { ids: [api.id], changes: { scopes, allGroups: true } },
		});
	expect((await grants([...writes, "groups:read", "users:read"])).status).toBe(
		200,
	);
	expect(
		(
			await context.request("/api-keys/enable", {
				method: "POST",
				body: { ids: [api.id] },
			})
		).status,
	).toBe(200);
	const parents = [];
	for (const path of ["/groups", "/users"]) {
		const body = { name: "Provisioned", notes: "private parent note" };
		const options = {
			method: "POST",
			body,
			headers: key(),
			credential: api.credential,
		};
		const first = await context.request(path, options);
		expect(first.status).toBe(200);
		const full = await checkedJSON(
			first,
			t.Object({ data: t.Object({ id: httpModel.id, notes: t.String() }) }),
		);
		expect(full.data.notes).toBe(body.notes);
		const bulk = {
			method: "PATCH",
			body: { ids: [full.data.id], changes: { name: "Review complete" } },
			headers: key(),
			credential: api.credential,
		};
		const updated = await checkedJSON(
			await context.request(path, bulk),
			t.Object({ data: t.Array(t.Object({ notes: t.String() })) }),
		);
		expect(updated.data[0]?.notes).toBe(body.notes);
		parents.push({ path, options, bulk, id: full.data.id });
	}
	expect((await grants(writes)).status).toBe(200);
	for (const { path, options, bulk, id } of parents) {
		expect(
			(await checkedJSON(await context.request(path, options), identity)).data,
		).toEqual({ id });
		const replay = await checkedJSON(
			await context.request(path, bulk),
			t.Object({
				data: t.Array(t.Object({ id: httpModel.id })),
				meta: t.Object({ operation: t.Object({ replayed: t.Literal(true) }) }),
			}),
		);
		expect(replay.data).toEqual([{ id }]);
		const created = await context.request(path, { ...options, headers: key() });
		const fresh = (await checkedJSON(created, identity)).data;
		expect(fresh).toEqual({ id: fresh.id });
		for (const [suffix, method, body] of [
			["", "PATCH", { ids: [id], changes: { name: "Updated" } }],
			["/enable", "POST", { ids: [id] }],
			["/disable", "POST", { ids: [id] }],
		] as const) {
			const result = await context.request(path + suffix, {
				method,
				body,
				credential: api.credential,
				headers: key(),
			});
			expect(result.status).toBe(200);
			expect(
				(
					await checkedJSON(
						result,
						t.Object({ data: t.Array(t.Object({ id: httpModel.id })) }),
					)
				).data,
			).toEqual([{ id }]);
		}
	}
	const groupId = parents[0]?.id;
	if (!groupId) throw new Error("Expected group");
	const options = {
		method: "POST",
		body: { groupId },
		credential: api.credential,
		headers: key(),
	};
	const created = await context.request("/licenses", options);
	expect(created.status).toBe(200);
	const license = (await checkedJSON(created, issuance)).data;
	expect(license).toEqual({ id: license.id, credential: license.credential });
	expect((await context.request("/licenses", options)).status).toBe(409);
	expect((await grants([...writes, "licenses:read"])).status).toBe(200);
	const readable = await context.request("/licenses", {
		...options,
		headers: key(),
	});
	expect(
		(
			await checkedJSON(
				readable,
				t.Object({
					data: t.Object({ group: t.Object({ notes: t.String() }) }),
				}),
			)
		).data.group.notes,
	).toBe("private parent note");
});

test("registration bodies require exactly their route's identifier and canonical duplicate hosts share capacity", async () => {
	const issued = await context.request("/licenses", {
		method: "POST",
		headers: key(),
		body: { deviceLimit: 1, ipLimit: 1 },
	});
	const licenseId = (await checkedJSON(issued, identity)).data.id;
	for (const path of [
		"/licenses/hardware/register",
		"/licenses/ips/register",
	]) {
		for (const body of [
			{ licenseId },
			{ licenseId, ip: "192.0.2.1", hardwareId: "d" },
		])
			expect(
				(await context.request(path, { method: "POST", body })).status,
			).toBe(400);
	}
	for (const ip of ["::ffff:192.0.2.1", "192.0.2.1"])
		expect(
			(
				await context.request("/licenses/ips/register", {
					method: "POST",
					body: { licenseId, ip },
				})
			).status,
		).toBe(200);
	const ips = [
		"::ffff:192.0.2.1",
		...Array.from({ length: 99 }, (_, i) => `198.51.100.${i + 1}`),
	];
	expect(
		(
			await context.request("/licenses/ips/remove", {
				method: "POST",
				body: { ids: [licenseId], ips },
			})
		).status,
	).toBe(200);
	const detail = await checkedJSON(
		await context.request(`/licenses/${licenseId}`),
		t.Object({ data: licenseModel.resource }),
	);
	expect(detail.data.registeredIps).toEqual([]);
});
