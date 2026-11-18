import { describe, expect, test } from "bun:test";
import { IdempotencyService } from "../../core/security/IdempotencyService";
import { InputPolicy } from "../../core/http/InputPolicy";
import type { Database } from "../../core/database/Database";
import type { SettingsService } from "../../plugins/settings/SettingsService";
import type { $Transaction } from "../../types/database";
import { receipts } from "../../core/database/schema/receipts";
import { settingsDefaults } from "../../plugins/settings/defaults";

const service = new IdempotencyService({} as Database, {} as SettingsService);
const hash = (text: string) =>
	new Bun.CryptoHasher("sha256").update(text).digest("hex");

function receiptTransaction(
	receipt: Pick<
		typeof receipts.$inferSelect,
		"fingerprint" | "result" | "secretIssued"
	>,
	expired = false,
	version = 2,
) {
	let deleted = false;
	let mutations = 0;
	const issued = receipt.secretIssued !== null;
	const scope = issued ? "licenses:create" : "licenses:update";
	const now = new Date("2026-10-01T00:00:00Z");
	const row = {
		version,
		authority: {
			ownerId: "root",
			allGroups: false,
			groupIds: [],
			scopes: [],
			scope,
		},
		...receipt,
	};
	const tx = {
		execute: async () => {},
		select: () => ({
			from: (table: unknown) =>
				table === receipts
					? { where: async () => [{ receipt: row, expired, now }] }
					: Promise.resolve([{ now }]),
		}),
		delete: () => ({
			where: async () => {
				deleted = true;
			},
		}),
		insert: () => ({ values: async () => {} }),
	};
	const transaction: Database["transaction"] = (work) =>
		work(tx as unknown as $Transaction);
	const commands = new IdempotencyService(
		{ transaction, idempotentTransaction: transaction },
		{ read: async () => settingsDefaults },
	);
	const id = Bun.randomUUIDv7();
	const execute = (input: unknown) =>
		commands.admin(
			{
				principal: { kind: "root", id: "root", name: "Root", scopes: [] },
				requestId: "request",
				clientIp: "127.0.0.1",
				idempotencyKey: "key",
			},
			issued ? "license.create" : "license.update",
			input,
			async () => {
				mutations++;
				return issued
					? { data: { id }, credential: "issued fixture" }
					: { data: { ids: [id] } };
			},
			issued ? { secretIds: () => [id] } : {},
		);
	return {
		execute,
		mutations: () => mutations,
		deleted: () => deleted,
	};
}

describe("idempotency fingerprints", () => {
	test("sorts distinct Unicode keys deterministically at every object depth", () => {
		const first = {
			metadata: { "\u00e9": 1, "e\u0301": 2, Z: { a: 1, A: 2 } },
		};
		const reordered = {
			metadata: { Z: { A: 2, a: 1 }, "e\u0301": 2, "\u00e9": 1 },
		};
		new InputPolicy().metadata(first.metadata);
		new InputPolicy().metadata(reordered.metadata);
		const expected = hash(
			'{"metadata":{"Z":{"A":2,"a":1},"e\u0301":2,"\u00e9":1}}',
		);
		expect(service.fingerprint(first)).toBe(expected);
		expect(service.fingerprint(reordered)).toBe(expected);
	});

	test("preserves distinct key spellings, values, types and array order", () => {
		const original = {
			metadata: { "\u00e9": 1, "e\u0301": 2 },
			values: [1, 2],
		};
		for (const changed of [
			{ ...original, metadata: { "\u00e9": 2, "e\u0301": 1 } },
			{ ...original, metadata: { "\u00e9": "1", "e\u0301": 2 } },
			{ ...original, metadata: { "\u00e9": 1 } },
			{ ...original, values: [2, 1] },
		])
			expect(service.fingerprint(changed)).not.toBe(
				service.fingerprint(original),
			);
		expect(service.fingerprint([{ b: 2, a: 1 }])).toBe(
			service.fingerprint([{ a: 1, b: 2 }]),
		);
	});

	test("an equivalent reordered Unicode object replays a current receipt", async () => {
		const first = { metadata: { "\u00e9": 1, "e\u0301": 2 } };
		const reordered = { metadata: { "e\u0301": 2, "\u00e9": 1 } };
		const receipt = {
			fingerprint: service.fingerprint(first),
			result: { data: { ids: [Bun.randomUUIDv7()] } },
			secretIssued: null,
		};
		const stored = receiptTransaction(receipt);
		await expect(stored.execute(reordered)).rejects.toMatchObject({
			result: receipt.result,
		});
		expect(stored.mutations()).toBe(0);
	});

	test("rejects a receipt with a different fingerprint", async () => {
		const input = { name: "legacy", metadata: { B: 2, a: 1 } };
		// A receipt written before the fix, when locale collation sorted a before B.
		const legacy = hash('{"metadata":{"a":1,"B":2},"name":"legacy"}');
		expect(service.fingerprint(input)).not.toBe(legacy);
		const receipt = {
			fingerprint: legacy,
			result: { completed: true },
			secretIssued: null,
		};
		const stored = receiptTransaction(receipt);
		await expect(stored.execute(input)).rejects.toMatchObject({
			code: "IDEMPOTENCY_KEY_REUSED",
		});
		const changed = { ...input, metadata: { B: 3, a: 1 } };
		await expect(stored.execute(changed)).rejects.toMatchObject({
			code: "IDEMPOTENCY_KEY_REUSED",
		});
	});

	test("secret receipts and expiry preserve issuance boundaries", async () => {
		const input = { name: "legacy", metadata: { B: 2, a: 1 } };
		const receipt = {
			fingerprint: service.fingerprint(input),
			result: null,
			secretIssued: [Bun.randomUUIDv7()],
		};
		await expect(
			receiptTransaction(receipt).execute(input),
		).rejects.toMatchObject({
			status: 409,
			code: "SECRET_ALREADY_ISSUED",
			resourceIds: receipt.secretIssued,
		});
		for (const invalid of [
			{ ...receipt, secretIssued: [] },
			{ ...receipt, result: { credential: "not safe to replay" } },
		]) {
			const malformed = receiptTransaction(invalid);
			await expect(malformed.execute(input)).rejects.toMatchObject({
				code: "INTERNAL_ERROR",
			});
			expect(malformed.mutations()).toBe(0);
		}
		const expired = receiptTransaction(receipt, true);
		await expired.execute(input);
		expect(expired.mutations()).toBe(1);
		expect(expired.deleted()).toBe(true);
	});
	test("legacy and malformed retained rows cannot re-disclose data or be mistaken for an unused key", async () => {
		const result = { data: { ids: [Bun.randomUUIDv7()] } };
		const fingerprint = service.fingerprint({});
		for (const version of [1, 3]) {
			const old = receiptTransaction(
				{ fingerprint, result, secretIssued: null },
				false,
				version,
			);
			await expect(old.execute({})).rejects.toMatchObject({
				code: "IDEMPOTENCY_KEY_REUSED",
			});
			expect(old.mutations()).toBe(0);
			expect(old.deleted()).toBe(false);
		}
		for (const invalid of [
			null,
			{ ...result, secret: "sentinel" },
			{ data: { ids: ["invalid"] } },
		]) {
			const malformed = receiptTransaction({
				fingerprint,
				result: invalid,
				secretIssued: null,
			});
			await expect(malformed.execute({})).rejects.toMatchObject({
				code: "INTERNAL_ERROR",
			});
			expect(malformed.mutations()).toBe(0);
			expect(malformed.deleted()).toBe(false);
		}
	});
});
