import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "../db";
import type { LicenseMeter, UsageLedgerEntry } from "../domain/entities";
import { hashUsageEventId } from "../domain/usageEvent";
import {
	DrizzleLicenseRepository,
	hashLicenseKey,
	licenseKeyPrefix,
} from "../infrastructure/repositories/DrizzleLicenseRepository";
import { DrizzleActivityRepository } from "../infrastructure/repositories/DrizzleActivityRepository";
import { DrizzleMeterRepository } from "../infrastructure/repositories/DrizzleMeterRepository";
import { DrizzleStripeWebhookRepository } from "../infrastructure/repositories/DrizzleStripeRepository";

class FakeQuery {
	constructor(private readonly rows: unknown[]) {}
	from() {
		return this;
	}
	innerJoin() {
		return this;
	}
	where() {
		return this;
	}
	limit() {
		return this;
	}
	orderBy() {
		return this;
	}
	for() {
		return this;
	}
	set() {
		return this;
	}
	values() {
		return this;
	}
	onConflictDoNothing() {
		return this;
	}
	onConflictDoUpdate() {
		return this;
	}
	async returning() {
		return this.rows;
	}
	// biome-ignore lint/suspicious/noThenProperty: Drizzle builders are promise-like.
	then<TResult1 = unknown[], TResult2 = never>(
		onfulfilled?:
			| ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
			| null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return Promise.resolve(this.rows).then(onfulfilled, onrejected);
	}
}

class FakeDatabase {
	constructor(
		private readonly selects: unknown[][],
		private readonly updates: unknown[][],
		private readonly inserts: unknown[][],
	) {}
	async execute() {
		return [];
	}
	select() {
		return new FakeQuery(this.selects.shift() ?? []);
	}
	update() {
		return new FakeQuery(this.updates.shift() ?? []);
	}
	insert() {
		return new FakeQuery(this.inserts.shift() ?? []);
	}
	async transaction<T>(operation: (database: FakeDatabase) => Promise<T>) {
		return await operation(this);
	}
}

const meter: LicenseMeter = {
	id: "meter-1",
	licenseId: "license-1",
	name: "credits",
	balance: 10,
	archivedAt: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const ledger: UsageLedgerEntry = {
	id: "ledger-1",
	licenseId: "license-1",
	meterId: meter.id,
	eventId: hashUsageEventId("event-1"),
	kind: "consume",
	delta: -3,
	balanceBefore: 10,
	balanceAfter: 7,
	reason: null,
	createdAt: new Date(0),
};

describe("license key persistence", () => {
	test("hashes secrets and stores only a display prefix", () => {
		const key = "lic_12345678-1234-7123-8123-123456789012";
		expect(hashLicenseKey(key)).toHaveLength(64);
		expect(hashLicenseKey(key)).not.toContain(key);
		expect(licenseKeyPrefix(key)).toBe(key.slice(0, 16));
	});

	test("continues hashing migrated sk_ secrets without prefix restrictions", () => {
		expect(hashLicenseKey("sk_legacy-secret")).toHaveLength(64);
	});
});

describe("DrizzleLicenseRepository", () => {
	test("rejects a stale admin snapshot before applying type policy", async () => {
		const database = new FakeDatabase(
			[[{ id: "license-1", updatedAt: new Date(1) }]],
			[],
			[],
		);
		const repository = new DrizzleLicenseRepository(
			database as unknown as Database,
		);
		await expect(
			repository.update(
				"license-1",
				{ type: "lifetime" },
				{ expectedUpdatedAt: new Date(0) },
			),
		).rejects.toThrow("changed concurrently");
	});

	test("returns the exact row written with a one-time rotated secret", async () => {
		const secret = "lic_rotation_a";
		const stored = {
			id: "license-1",
			keyHash: hashLicenseKey(secret),
			keyPrefix: licenseKeyPrefix(secret),
			customerId: "customer-1",
			type: "lifetime" as const,
			maxIps: 0,
			maxDevices: 0,
			maxSessions: 0,
			sessionRevision: 1,
			trialDurationMinutes: 0,
			trialStartedAt: null,
			metadata: {},
			expiresAt: null,
			typeDrafts: { lifetime: {} },
			manualRevokedAt: null,
			manualRevocationReason: null,
			createdAt: new Date(0),
			updatedAt: new Date(1),
		};
		const database = new FakeDatabase(
			[[{ billingRevokedAt: null }]],
			[[stored]],
			[],
		);
		const repository = new DrizzleLicenseRepository(
			database as unknown as Database,
		);
		expect(
			await repository.rotateKey("license-1", secret, new Date(0)),
		).toMatchObject({
			licenseKey: secret,
			keyPrefix: licenseKeyPrefix(secret),
			sessionRevision: 1,
		});
	});
});

describe("DrizzleMeterRepository", () => {
	test("atomically consumes units and writes a ledger entry", async () => {
		const updated = { ...meter, balance: 7 };
		const database = new FakeDatabase([[], [meter]], [[updated]], [[ledger]]);
		const repository = new DrizzleMeterRepository(
			database as unknown as Database,
		);
		expect(
			await repository.consume("license-1", "credits", 3, "event-1"),
		).toEqual({ status: "consumed", meter: updated, entry: ledger });
		expect(ledger.eventId).not.toBe("event-1");
	});

	test("replays an identical event without a second debit", async () => {
		const database = new FakeDatabase([[{ entry: ledger, meter }]], [], []);
		const repository = new DrizzleMeterRepository(
			database as unknown as Database,
		);
		expect(
			await repository.consume("license-1", "credits", 3, "event-1"),
		).toMatchObject({
			status: "replayed",
			meter: { balance: 7 },
		});
	});

	test("rejects conflicting idempotency reuse", async () => {
		const database = new FakeDatabase([[{ entry: ledger, meter }]], [], []);
		const repository = new DrizzleMeterRepository(
			database as unknown as Database,
		);
		expect(
			await repository.consume("license-1", "credits", 4, "event-1"),
		).toEqual({ status: "conflict" });
	});

	test("reports exhaustion without inserting a ledger entry", async () => {
		const database = new FakeDatabase([[], [meter]], [[]], []);
		const repository = new DrizzleMeterRepository(
			database as unknown as Database,
		);
		expect(
			await repository.consume("license-1", "credits", 11, "event-2"),
		).toEqual({ status: "exhausted" });
	});

	test("protects the final active meter inside the repository lock", async () => {
		const database = new FakeDatabase([[{ type: "metered" }], [meter]], [], []);
		const repository = new DrizzleMeterRepository(
			database as unknown as Database,
		);
		expect(
			await repository.archiveMeter("license-1", "credits", "retired"),
		).toEqual(meter);
		expect(meter.archivedAt).toBeNull();
	});

	test("archives one of multiple active meters", async () => {
		const archived = { ...meter, archivedAt: new Date() };
		const other = { ...meter, id: "meter-2", name: "exports" };
		const database = new FakeDatabase(
			[[{ type: "metered" }], [meter, other]],
			[[archived]],
			[],
		);
		const repository = new DrizzleMeterRepository(
			database as unknown as Database,
		);
		expect(
			await repository.archiveMeter("license-1", "credits", "retired"),
		).toEqual(archived);
	});
});

describe("DrizzleActivityRepository", () => {
	test("prunes both tables in Postgres without materializing deleted rows", async () => {
		let running = 0;
		let peak = 0;
		const dialect = new PgDialect();
		const counts = [[{ count: 2 }], [{ count: 3 }]];
		const statements: string[] = [];

		const transaction = {
			delete: () => {
				throw new Error("prune must not stream deleted rows to the client");
			},
			execute: async (query: SQL) => {
				running += 1;
				peak = Math.max(peak, running);
				statements.push(dialect.sqlToQuery(query).sql);
				await Bun.sleep(1);
				running -= 1;
				return counts.shift() ?? [];
			},
		};
		const database = {
			transaction: async <T>(operation: (scoped: unknown) => Promise<T>) =>
				await operation(transaction),
		};
		const repository = new DrizzleActivityRepository(
			database as unknown as Database,
		);

		expect(await repository.pruneBefore(new Date(0))).toBe(5);
		expect(peak).toBe(1);
		expect(statements).toHaveLength(2);
		for (const statement of statements) {
			expect(statement).toContain("count(*)::int");
		}
	});
});

describe("DrizzleStripeWebhookRepository", () => {
	test("leases due work and makes stale processing events reclaimable", async () => {
		const now = new Date("2026-08-15T00:00:00.000Z");
		const stored = {
			eventId: "evt_1",
			type: "customer.subscription.updated",
			objectId: "sub_1",
			status: "processing" as const,
			attempts: 1,
			nextAttemptAt: new Date("2026-08-14T23:59:00.000Z"),
			payload: {},
			lastError: "worker stopped",
			receivedAt: new Date(0),
			processedAt: null,
		};
		const database = new FakeDatabase([[stored]], [[]], []);
		const repository = new DrizzleStripeWebhookRepository(
			database as unknown as Database,
		);
		const claimed = await repository.claimDue(10, now);
		expect(claimed[0]).toMatchObject({
			eventId: "evt_1",
			status: "processing",
			attempts: 2,
			lastError: null,
			nextAttemptAt: new Date("2026-08-15T00:01:00.000Z"),
		});
	});
});
