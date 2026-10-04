import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { Elysia, ValidationError } from "elysia";
import { AuthService } from "../../core/auth/AuthService";
import { apiKeys } from "../../core/database/schema/apiKeys";
import { audits } from "../../core/database/schema/audits";
import { deliveries } from "../../core/database/schema/deliveries";
import { items } from "../../core/database/schema/items";
import { licenses } from "../../core/database/schema/licenses";
import { users } from "../../core/database/schema/users";
import { webhooks } from "../../core/database/schema/webhooks";
import { ClientIpResolver } from "../../core/http/ClientIpResolver";
import { HttpError } from "../../core/http/HttpError";
import { RateLimiter } from "../../core/http/RateLimiter";
import { RequestService } from "../../core/http/RequestService";
import { Redis } from "../../core/redis/Redis";
import { IdempotencyService } from "../../core/security/IdempotencyService";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { Replay } from "../../core/security/Replay";
import { SecretHasher } from "../../core/security/SecretHasher";
import { AuditService } from "../../plugins/audits/AuditService";
import { ItemService } from "../../plugins/items/ItemService";
import { itemRoutes } from "../../plugins/items/index";
import { LicenseDeletion } from "../../plugins/licenses/LicenseDeletion";
import { SettingsService } from "../../plugins/settings/SettingsService";
import { UserService } from "../../plugins/users/UserService";
import { userRoutes } from "../../plugins/users/index";
import { EventService } from "../../plugins/webhooks/EventService";
import type { $Operation } from "../../types/operation";
import { TestDatabase } from "../fixtures/TestDatabase";

const fixture = new TestDatabase();
const database = fixture.database;
const keys = new KeyGenerator();
const master = keys.master();
const hasher = new SecretHasher();
const auth = new AuthService(database, master);
const audit = new AuditService();
const events = new EventService();
const ip = new ClientIpResolver(database);
const settings = new SettingsService(database, audit, ip);
const idem = new IdempotencyService(database, settings);
const deletion = new LicenseDeletion(audit, events);
const userService = new UserService(
	database,
	auth,
	audit,
	events,
	settings,
	idem,
	deletion,
);
const itemService = new ItemService(
	database,
	auth,
	audit,
	events,
	settings,
	idem,
	deletion,
	keys,
);
const root: $Operation = {
	principal: { kind: "root", id: "root", name: "Root", scopes: [] },
	requestId: Bun.randomUUIDv7(),
	clientIp: "127.0.0.1",
};
const redisUrl = Bun.env.KZ_TEST_REDIS_URL;
if (!redisUrl)
	throw new Error(
		"KZ_TEST_REDIS_URL is required for parent HTTP integration tests",
	);
const redis = new Redis(redisUrl);
const requests = new RequestService(auth, ip, new RateLimiter(redis), settings);
const app = new Elysia({ normalize: false })
	.error("global", HttpError, ({ error }) =>
		Response.json(error.response(), { status: error.status }),
	)
	.error("global", ValidationError, () =>
		Response.json(
			{ code: "INVALID_REQUEST", reason: "Request validation failed" },
			{ status: 400 },
		),
	)
	.error("global", Replay, ({ error }) => Response.json(error.result))
	.use(userRoutes(userService, requests))
	.use(itemRoutes(itemService, requests));

beforeAll(async () => {
	await fixture.start();
	await redis.connect();
	await settings.update({ rateLimitEnabled: false }, root.principal, root);
	await database.orm.insert(webhooks).values({
		id: Bun.randomUUIDv7(),
		url: "http://127.0.0.1:1/notifications",
		events: ["*"],
		enabled: true,
		createdBy: "root",
		updatedBy: "root",
	});
	app.listen({ hostname: "127.0.0.1", port: 0 });
});
afterAll(async () => {
	await app.stop();
	redis.close();
	await fixture.stop();
});

describe("User and Item lifecycle", () => {
	test("creation preserves exact names and typed metadata, allows duplicates and starts disabled", async () => {
		const first = await userService.create(
			{
				name: " Exact Name ",
				metadata: { string: "12", number: 12 },
				notes: "Private",
			},
			root,
		);
		const second = await userService.create({ name: " Exact Name " }, root);
		expect(first.data.name).toBe(" Exact Name ");
		expect(first.data.enabled).toBe(false);
		expect(first.data.metadata).toEqual({ string: "12", number: 12 });
		expect(first.data.id).not.toBe(second.data.id);
		const item = await itemService.create({ name: "Item" }, root);
		expect(item.data.enabled).toBe(false);
		expect(item.data.keyFormat).toBeNull();
	});

	test("metadata replacement and explicit lifecycle actions retain audit evidence", async () => {
		const created = await userService.create(
			{
				name: "Transitions",
				metadata: { old: "removed" },
				notes: "Secret note",
			},
			root,
		);
		const id = created.data.id;
		const updated = await userService.update(
			{ ids: [id], changes: { metadata: { new: "value" }, notes: null } },
			root,
		);
		expect(updated.data[0]?.metadata).toEqual({ new: "value" });
		expect(updated.data[0]?.notes).toBeNull();
		await userService.disable(
			{
				ids: [id],
				disabledReason: "Private explanation",
				reason: "Support action",
			},
			root,
		);
		const enabled = await userService.enable({ ids: [id] }, root);
		expect(enabled.data[0]?.enabled).toBe(true);
		expect(enabled.data[0]?.disabledReason).toBeNull();
		const evidence = await database.orm
			.select()
			.from(audits)
			.where(and(eq(audits.targetId, id), eq(audits.action, "user.enabled")));
		expect(evidence[0]?.before).toEqual({
			enabled: false,
			disabledReason: "Private explanation",
		});
	});

	test("no-op updates and repeated state actions create no audit, notification or timestamp changes", async () => {
		const created = await itemService.create(
			{ name: "No-op", metadata: { number: 12 } },
			root,
		);
		const id = created.data.id;
		const beforeAudits = await database.orm
			.select()
			.from(audits)
			.where(eq(audits.targetId, id));
		const beforeEvents = await database.orm
			.select()
			.from(deliveries)
			.where(sql`${deliveries.payload}->'data'->>'itemId' = ${id}`);
		const result = await itemService.update(
			{ ids: [id], changes: { name: "No-op", metadata: { number: 12 } } },
			root,
		);
		await itemService.disable({ ids: [id] }, root);
		expect(result.data[0]?.updatedAt).toBe(created.data.updatedAt);
		expect(
			await database.orm.select().from(audits).where(eq(audits.targetId, id)),
		).toHaveLength(beforeAudits.length);
		expect(
			await database.orm
				.select()
				.from(deliveries)
				.where(sql`${deliveries.payload}->'data'->>'itemId' = ${id}`),
		).toHaveLength(beforeEvents.length);
	});

	test("a missing bulk target or duplicate ID leaves all valid targets unchanged", async () => {
		const user = await userService.create({ name: "Atomic user" }, root);
		const item = await itemService.create({ name: "Atomic item" }, root);
		await expect(
			userService.update(
				{ ids: [user.data.id, Bun.randomUUIDv7()], changes: { name: "Lost" } },
				root,
			),
		).rejects.toMatchObject({ code: "BULK_OPERATION_FAILED" });
		await expect(
			itemService.enable({ ids: [item.data.id, Bun.randomUUIDv7()] }, root),
		).rejects.toMatchObject({ code: "BULK_OPERATION_FAILED" });
		expect(() =>
			userService.enable({ ids: [user.data.id, user.data.id] }, root),
		).toThrow(HttpError);
		expect(
			(
				await database.orm
					.select()
					.from(users)
					.where(eq(users.id, user.data.id))
			)[0]?.name,
		).toBe("Atomic user");
		expect(
			(
				await database.orm
					.select()
					.from(items)
					.where(eq(items.id, item.data.id))
			)[0]?.enabled,
		).toBe(false);
	});

	test("parent deletion requires both scopes and preserves each cascaded licence event and audit", async () => {
		const user = await userService.create({ name: "Cascade user" }, root);
		const item = await itemService.create({ name: "Remaining item" }, root);
		const licenseId = Bun.randomUUIDv7();
		await database.orm.insert(licenses).values({
			id: licenseId,
			keyHash: hasher.hash(keys.license()),
			enabled: true,
			userId: user.data.id,
			itemId: item.data.id,
			keyFormat: KeyGenerator.defaultFormat,
			createdBy: "root",
			updatedBy: "root",
		});
		await userService.disable(
			{ ids: [user.data.id], disabledReason: "Parent disabled" },
			root,
		);
		expect(
			(
				await database.orm
					.select()
					.from(licenses)
					.where(eq(licenses.id, licenseId))
			)[0]?.enabled,
		).toBe(true);
		const scoped: $Operation = {
			...root,
			principal: {
				kind: "api",
				id: Bun.randomUUIDv7(),
				name: "Parent deletion",
				scopes: ["users:delete"],
			},
		};
		await expect(
			userService.remove(
				{ ids: [user.data.id], confirm: true, reason: "Requested deletion" },
				scoped,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const authorized: $Operation = {
			...scoped,
			principal: {
				...scoped.principal,
				scopes: ["users:delete", "licenses:delete"],
			},
		};
		await userService.remove(
			{ ids: [user.data.id], confirm: true, reason: "Requested deletion" },
			authorized,
		);
		expect(
			await database.orm.select().from(users).where(eq(users.id, user.data.id)),
		).toHaveLength(0);
		expect(
			await database.orm
				.select()
				.from(licenses)
				.where(eq(licenses.id, licenseId)),
		).toHaveLength(0);
		expect(
			await database.orm.select().from(items).where(eq(items.id, item.data.id)),
		).toHaveLength(1);
		expect(
			await database.orm
				.select()
				.from(audits)
				.where(
					and(
						eq(audits.action, "license.deleted"),
						eq(audits.targetId, licenseId),
					),
				),
		).toHaveLength(1);
		expect(
			await database.orm
				.select()
				.from(deliveries)
				.where(
					sql`${deliveries.payload}->>'event' = 'license.deleted' and ${deliveries.payload}->'data'->>'licenseId' = ${licenseId}`,
				),
		).toHaveLength(1);
	});

	test("Item deletion removes related licences while retaining the User", async () => {
		const user = await userService.create({ name: "Remaining user" }, root);
		const item = await itemService.create({ name: "Cascade item" }, root);
		const licenseId = Bun.randomUUIDv7();
		await database.orm.insert(licenses).values({
			id: licenseId,
			keyHash: hasher.hash(keys.license()),
			userId: user.data.id,
			itemId: item.data.id,
			keyFormat: KeyGenerator.defaultFormat,
			createdBy: "root",
			updatedBy: "root",
		});
		await itemService.remove(
			{ ids: [item.data.id], confirm: true, reason: "Requested deletion" },
			root,
		);
		expect(
			await database.orm
				.select()
				.from(licenses)
				.where(eq(licenses.id, licenseId)),
		).toHaveLength(0);
		expect(
			await database.orm.select().from(users).where(eq(users.id, user.data.id)),
		).toHaveLength(1);
	});

	test("licence principals receive only their related safe projections and cannot list or mutate", async () => {
		const user = await userService.create(
			{
				name: "Public user",
				notes: "Never disclose",
				metadata: { public: "value" },
			},
			root,
		);
		const item = await itemService.create(
			{ name: "Public item", notes: "Never disclose" },
			root,
		);
		await userService.enable({ ids: [user.data.id] }, root);
		await itemService.enable({ ids: [item.data.id] }, root);
		const credential = keys.license();
		await database.orm.insert(licenses).values({
			id: Bun.randomUUIDv7(),
			keyHash: hasher.hash(credential),
			enabled: true,
			userId: user.data.id,
			itemId: item.data.id,
			keyFormat: KeyGenerator.defaultFormat,
			createdBy: "root",
			updatedBy: "root",
		});
		const operation: $Operation = {
			...root,
			principal: await auth.authenticate(`Bearer ${credential}`),
		};
		const userResult = await userService.read(
			new URLSearchParams({ id: user.data.id }),
			operation,
		);
		const itemResult = await itemService.read(
			new URLSearchParams({ id: item.data.id }),
			operation,
		);
		expect(Object.keys(userResult.data).sort()).toEqual([
			"createdAt",
			"enabled",
			"id",
			"metadata",
			"name",
			"updatedAt",
		]);
		expect(Object.keys(itemResult.data).sort()).toEqual([
			"createdAt",
			"enabled",
			"id",
			"metadata",
			"name",
			"updatedAt",
		]);
		await expect(
			userService.read(new URLSearchParams(), operation),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			userService.read(
				new URLSearchParams({ id: Bun.randomUUIDv7() }),
				operation,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			itemService.read(
				new URLSearchParams({ id: item.data.id, search: "Never" }),
				operation,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			itemService.update(
				{ ids: [item.data.id], changes: { name: "Denied" } },
				operation,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("Item format overrides remain saved through global mode changes and reject weak formats", async () => {
		await expect(
			itemService.create(
				{ name: "Blocked override", keyFormat: KeyGenerator.defaultFormat },
				root,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await settings.update({ globalFormatEnabled: false }, root.principal, root);
		try {
			await expect(
				itemService.create(
					{
						name: "Weak override",
						keyFormat: { ...KeyGenerator.defaultFormat, groups: 1, length: 1 },
					},
					root,
				),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
			const format = { ...KeyGenerator.defaultFormat, prefix: "SAVED" };
			const item = await itemService.create(
				{ name: "Saved override", keyFormat: format },
				root,
			);
			await settings.update(
				{ globalFormatEnabled: true },
				root.principal,
				root,
			);
			await expect(
				itemService.update(
					{ ids: [item.data.id], changes: { keyFormat: null } },
					root,
				),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await itemService.update(
				{ ids: [item.data.id], changes: { name: "Still editable" } },
				root,
			);
			expect(
				(
					await database.orm
						.select()
						.from(items)
						.where(eq(items.id, item.data.id))
				)[0]?.keyFormat,
			).toEqual(format);
		} finally {
			await settings.update(
				{ globalFormatEnabled: true },
				root.principal,
				root,
			);
		}
	});

	test("typed metadata filtering distinguishes strings from numbers and pagination uses stable cursors", async () => {
		const name = `Pages-${Bun.randomUUIDv7()}`;
		for (let index = 0; index < 12; index++)
			await userService.create(
				{ name, metadata: { kind: index % 2 ? "12" : 12 } },
				root,
			);
		const first = await userService.read(
			new URLSearchParams({ search: name, direction: "asc" }),
			root,
		);
		expect(first.data).toHaveLength(10);
		if (!("nextCursor" in first) || !first.nextCursor)
			throw new Error("Expected cursor");
		const second = await userService.read(
			new URLSearchParams({
				search: name,
				direction: "asc",
				cursor: first.nextCursor,
			}),
			root,
		);
		expect(second.data).toHaveLength(2);
		const stringMatches = await userService.read(
			new URLSearchParams({ search: name, "metadata.kind": "12" }),
			root,
		);
		const numericMatches = await userService.read(
			new URLSearchParams({ search: name, "metadataNumber.kind": "12" }),
			root,
		);
		expect(stringMatches.data).toHaveLength(6);
		expect(numericMatches.data).toHaveLength(6);
		const injected = await userService.read(
			new URLSearchParams({ search: name, "metadata.x') OR TRUE --": "value" }),
			root,
		);
		expect(injected.data).toHaveLength(0);
	});

	test("concurrent idempotent creates store one resource and replay the safe result", async () => {
		const operation = { ...root, idempotencyKey: Bun.randomUUIDv7() };
		const input = { name: `Idempotent-${Bun.randomUUIDv7()}` };
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () => userService.create(input, operation)),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		for (const result of results)
			if (result.status === "rejected")
				expect(result.reason).toBeInstanceOf(Replay);
		expect(
			await database.orm.select().from(users).where(eq(users.name, input.name)),
		).toHaveLength(1);
		await expect(
			userService.create({ name: "Different command" }, operation),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
	});

	test("UTF-8 limits reject excessive notes and metadata values", async () => {
		await expect(
			userService.create(
				{ name: "Too many bytes", notes: "🐈".repeat(4097) },
				root,
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await expect(
			itemService.create(
				{ name: "Too many bytes", metadata: { value: "🐈".repeat(2049) } },
				root,
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});
});

describe("composed User and Item HTTP routes", () => {
	test("every action remains authenticated after feature composition", async () => {
		if (!app.server) throw new Error("HTTP fixture is not listening");
		for (const family of ["users", "items"]) {
			for (const [method, suffix, body] of [
				["GET", "", undefined],
				["POST", "", { name: "Unauthorized" }],
				[
					"PATCH",
					"",
					{ ids: [Bun.randomUUIDv7()], changes: { name: "Unauthorized" } },
				],
				[
					"DELETE",
					"",
					{ ids: [Bun.randomUUIDv7()], confirm: true, reason: "Unauthorized" },
				],
				["POST", "/enable", { ids: [Bun.randomUUIDv7()] }],
				["POST", "/disable", { ids: [Bun.randomUUIDv7()] }],
			] as const) {
				const response = await fetch(
					new URL(`/${family}${suffix}`, app.server.url),
					{
						method,
						headers: body ? { "content-type": "application/json" } : undefined,
						body: body ? JSON.stringify(body) : undefined,
					},
				);
				expect(response.status).toBe(401);
				await response.body?.cancel();
			}
		}
	});

	test("strict bodies reject enabled injection and wrong JSON types without coercion", async () => {
		if (!app.server) throw new Error("HTTP fixture is not listening");
		for (const family of ["users", "items"]) {
			for (const body of [{ name: "Unknown", enabled: true }, { name: 42 }]) {
				const response = await fetch(new URL(`/${family}`, app.server.url), {
					method: "POST",
					headers: {
						authorization: `Bearer ${master}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				});
				expect(response.status).toBe(400);
				await response.body?.cancel();
			}
		}
	});

	test("normal API keys cannot escape their granted feature action", async () => {
		if (!app.server) throw new Error("HTTP fixture is not listening");
		const id = Bun.randomUUIDv7();
		const key = keys.api(id);
		await database.orm.insert(apiKeys).values({
			id,
			name: "Read users",
			secretHash: hasher.hash(key.secret),
			scopes: ["users:read"],
			enabled: true,
			createdBy: "root",
			updatedBy: "root",
		});
		for (const [method, path, body] of [
			["GET", "/users", undefined],
			["GET", "/items", undefined],
			["POST", "/users", { name: "Forbidden" }],
		] as const) {
			const response = await fetch(new URL(path, app.server.url), {
				method,
				headers: {
					authorization: `Bearer ${key.credential}`,
					"content-type": "application/json",
				},
				body: body ? JSON.stringify(body) : undefined,
			});
			expect(response.status).toBe(
				method === "GET" && path === "/users" ? 200 : 403,
			);
			await response.body?.cancel();
		}
	});
});
