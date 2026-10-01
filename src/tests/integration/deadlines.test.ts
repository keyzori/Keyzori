import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { apiKeys } from "../../core/database/schema/apiKeys";
import { hardware } from "../../core/database/schema/hardware";
import { items } from "../../core/database/schema/items";
import { licenses } from "../../core/database/schema/licenses";
import { meters } from "../../core/database/schema/meters";
import { receipts } from "../../core/database/schema/receipts";
import { users } from "../../core/database/schema/users";
import { RequestService } from "../../core/http/RequestService";
import { RequestTracker } from "../../core/http/RequestTracker";
import { RateLimiter } from "../../core/http/RateLimiter";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { SecretHasher } from "../../core/security/SecretHasher";
import { TestContext } from "../fixtures/TestContext";

const context = new TestContext();
const database = context.database;
beforeAll(() => context.start());
afterAll(() => context.stop());

describe("database deadlines", () => {
	test("expired deadlines reject before starting a mutation", async () => {
		let started = false;
		await expect(
			database.transaction(
				async () => {
					started = true;
				},
				"write",
				Date.now() - 1,
			),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(started).toBe(false);
	});

	test("pool reservation expires without leaving queued mutation work", async () => {
		const reserved = await Promise.all(
			Array.from({ length: 20 }, () => database.client.reserve()),
		);
		let mutated = false;
		const started = performance.now();
		try {
			await expect(
				database.transaction(
					async () => {
						mutated = true;
					},
					"write",
					Date.now() + 60,
				),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
			expect(performance.now() - started).toBeLessThan(500);
		} finally {
			for (const connection of reserved) connection.release();
		}
		await database.transaction(async (tx) => {
			await tx.execute(sql`select 1`);
		});
		expect(mutated).toBe(false);
	});

	test("statement timeout rolls back earlier writes before reporting unavailable", async () => {
		const id = Bun.randomUUIDv7();
		await expect(
			database.transaction(
				async (tx) => {
					await tx.insert(users).values({
						id,
						name: "Rollback statement",
						createdBy: "root",
						updatedBy: "root",
					});
					await tx.execute(sql`set local statement_timeout = '50ms'`);
					await tx.execute(sql`select pg_sleep(1)`);
				},
				"write",
				Date.now() + 1000,
			),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(
			await database.orm.select().from(users).where(eq(users.id, id)),
		).toHaveLength(0);
		expect(await database.ping()).toBe(true);
	});

	test("one deadline covers successive SQL statements and rolls back the whole mutation", async () => {
		const id = Bun.randomUUIDv7();
		const started = performance.now();
		await expect(
			database.transaction(
				async (tx) => {
					await tx.insert(users).values({
						id,
						name: "Rollback total time",
						createdBy: "root",
						updatedBy: "root",
					});
					await tx.execute(sql`select pg_sleep(0.1)`);
					await tx.execute(sql`select pg_sleep(0.1)`);
				},
				"write",
				Date.now() + 160,
			),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(performance.now() - started).toBeLessThan(500);
		expect(
			await database.orm.select().from(users).where(eq(users.id, id)),
		).toHaveLength(0);
	});

	test("precommit elapsed check awaits callback completion and prevents a late commit", async () => {
		const id = Bun.randomUUIDv7();
		let completed = false;
		await expect(
			database.transaction(
				async (tx) => {
					await tx.insert(users).values({
						id,
						name: "Never commit after timeout",
						createdBy: "root",
						updatedBy: "root",
					});
					await Bun.sleep(100);
					completed = true;
				},
				"write",
				Date.now() + 50,
			),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(completed).toBe(true);
		expect(
			await database.orm.select().from(users).where(eq(users.id, id)),
		).toHaveLength(0);
	});

	test("row lock timeout rolls back a preceding write", async () => {
		const lockedId = Bun.randomUUIDv7();
		const rollbackId = Bun.randomUUIDv7();
		await database.orm.insert(users).values({
			id: lockedId,
			name: "Locked row",
			createdBy: "root",
			updatedBy: "root",
		});
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocker = database.orm.transaction(async (tx) => {
			await tx.select().from(users).where(eq(users.id, lockedId)).for("update");
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		try {
			await expect(
				database.transaction(
					async (tx) => {
						await tx.insert(users).values({
							id: rollbackId,
							name: "Rollback lock",
							createdBy: "root",
							updatedBy: "root",
						});
						await tx.execute(sql`set local lock_timeout = '40ms'`);
						await tx
							.select()
							.from(users)
							.where(eq(users.id, lockedId))
							.for("update");
					},
					"write",
					Date.now() + 1000,
				),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		} finally {
			release.resolve();
			await blocker;
		}
		expect(
			await database.orm.select().from(users).where(eq(users.id, rollbackId)),
		).toHaveLength(0);
	});
});

describe("request deadline propagation", () => {
	test("idempotent mutation deadline rolls back its resource and receipt", async () => {
		const id = Bun.randomUUIDv7();
		const operation = {
			...context.operation(),
			idempotencyKey: Bun.randomUUIDv7(),
			deadlineAt: Date.now() + 80,
		};
		await expect(
			context.idempotency.admin(
				operation,
				"deadline.fixture",
				{ id },
				async (tx) => {
					await tx.insert(users).values({
						id,
						name: "No late receipt",
						createdBy: "root",
						updatedBy: "root",
					});
					await tx.execute(sql`select pg_sleep(1)`);
					return { id };
				},
				{ topology: "write" },
			),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(
			await database.orm.select().from(users).where(eq(users.id, id)),
		).toHaveLength(0);
		expect(
			await database.orm
				.select()
				.from(receipts)
				.where(eq(receipts.key, operation.idempotencyKey)),
		).toHaveLength(0);
	});

	test("authentication obeys the request deadline while updating last-used attribution", async () => {
		const id = Bun.randomUUIDv7();
		const credential = new KeyGenerator().api(id);
		await database.orm.insert(apiKeys).values({
			id,
			name: "Deadline key",
			enabled: true,
			secretHash: new SecretHasher().hash(credential.secret),
			scopes: ["users:read"],
			createdBy: "root",
			updatedBy: "root",
		});
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocker = database.orm.transaction(async (tx) => {
			await tx.select().from(apiKeys).where(eq(apiKeys.id, id)).for("update");
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		try {
			await expect(
				context.auth.authenticate(
					`Bearer ${credential.credential}`,
					Date.now() + 80,
				),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		} finally {
			release.resolve();
			await blocker;
		}
		expect(
			(await database.orm.select().from(apiKeys).where(eq(apiKeys.id, id)))[0]
				?.lastUsedAt,
		).toBeNull();
	});

	test("IP resolution and request authorization retain the initial tracker deadline", async () => {
		const tracker = new RequestTracker();
		const requests = new RequestService(
			context.auth,
			context.ip,
			new RateLimiter(context.redis),
			context.settings,
			tracker,
		);
		const request = new Request("http://127.0.0.1/users", {
			headers: { authorization: `Bearer ${context.master}` },
		});
		const tracked = tracker.begin(request);
		const operation = await requests.authorize(
			request,
			"127.0.0.1",
			"users:read",
		);
		expect(operation.deadlineAt).toBe(tracked.deadlineAt);
		const blockedRequest = new Request("http://127.0.0.1/validate");
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocker = database.transaction(async () => {
			acquired.resolve();
			await release.promise;
		}, "write");
		await acquired.promise;
		tracker.begin(blockedRequest).deadlineAt = Date.now() + 80;
		try {
			await expect(
				requests.runtime(blockedRequest, "127.0.0.1"),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		} finally {
			release.resolve();
			await blocker;
		}
	});

	test("validation deadline cannot register hardware, charge a meter or save a receipt later", async () => {
		const issued = await context.licenses.create(
			{ deviceLimit: 1, meters: { upsert: [{ name: "uses", limit: 5 }] } },
			context.operation(),
		);
		await context.licenses.enable(
			{ ids: [issued.data.id] },
			context.operation(),
		);
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocker = database.orm.transaction(async (tx) => {
			await tx
				.select()
				.from(licenses)
				.where(eq(licenses.id, issued.data.id))
				.for("update");
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		const operation = {
			...context.operation(),
			idempotencyKey: Bun.randomUUIDv7(),
			deadlineAt: Date.now() + 80,
		};
		try {
			await expect(
				context.validation.validate(
					{
						license: issued.credential,
						hardwareId: "deadline-device",
						usage: { uses: 1 },
					},
					operation,
				),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		} finally {
			release.resolve();
			await blocker;
		}
		expect(
			await database.orm
				.select()
				.from(hardware)
				.where(eq(hardware.licenseId, issued.data.id)),
		).toHaveLength(0);
		expect(
			(
				await database.orm
					.select()
					.from(meters)
					.where(eq(meters.licenseId, issued.data.id))
			)[0]?.value,
		).toBe("0");
		expect(
			await database.orm
				.select()
				.from(receipts)
				.where(eq(receipts.key, operation.idempotencyKey)),
		).toHaveLength(0);
	});

	test("licence read recheck rejects credentials rotated after authentication", async () => {
		const issued = await context.licenses.create({}, context.operation());
		await context.licenses.enable(
			{ ids: [issued.data.id] },
			context.operation(),
		);
		const principal = await context.auth.authenticate(
			`Bearer ${issued.credential}`,
		);
		expect(
			(
				await database.transaction((tx) =>
					context.auth.assertLicense(tx, principal),
				)
			)?.id,
		).toBe(issued.data.id);
		await context.licenses.rotate(
			{ ids: [issued.data.id] },
			context.operation(),
		);
		await expect(
			database.transaction((tx) => context.auth.assertLicense(tx, principal)),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(
			await database.transaction((tx) =>
				context.auth.assertLicense(tx, context.operation().principal),
			),
		).toBeUndefined();
	});

	test("licence read recheck evaluates current expiry, lifecycle and parent state", async () => {
		const userId = Bun.randomUUIDv7();
		const itemId = Bun.randomUUIDv7();
		await database.orm.insert(users).values({
			id: userId,
			name: "Read parent",
			enabled: true,
			createdBy: "root",
			updatedBy: "root",
		});
		await database.orm.insert(items).values({
			id: itemId,
			name: "Read parent",
			enabled: true,
			createdBy: "root",
			updatedBy: "root",
		});
		const issued = await context.licenses.create(
			{ userId, itemId },
			context.operation(),
		);
		await context.licenses.enable(
			{ ids: [issued.data.id] },
			context.operation(),
		);
		const principal = await context.auth.authenticate(
			`Bearer ${issued.credential}`,
		);
		await database.orm
			.update(licenses)
			.set({ enabled: false })
			.where(eq(licenses.id, issued.data.id));
		await expect(
			database.transaction((tx) => context.auth.assertLicense(tx, principal)),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await database.orm
			.update(licenses)
			.set({ enabled: true, expiresAt: new Date(0) })
			.where(eq(licenses.id, issued.data.id));
		await expect(
			database.transaction((tx) => context.auth.assertLicense(tx, principal)),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await database.orm
			.update(licenses)
			.set({ expiresAt: null })
			.where(eq(licenses.id, issued.data.id));
		await database.orm
			.update(users)
			.set({ enabled: false })
			.where(eq(users.id, userId));
		await expect(
			database.transaction((tx) => context.auth.assertLicense(tx, principal)),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await database.orm
			.update(users)
			.set({ enabled: true })
			.where(eq(users.id, userId));
		await database.orm
			.update(items)
			.set({ enabled: false })
			.where(eq(items.id, itemId));
		await expect(
			database.transaction((tx) => context.auth.assertLicense(tx, principal)),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await database.orm
			.update(items)
			.set({ enabled: true })
			.where(eq(items.id, itemId));
		await database.orm.delete(licenses).where(eq(licenses.id, issued.data.id));
		await expect(
			database.transaction((tx) => context.auth.assertLicense(tx, principal)),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
