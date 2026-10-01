import { describe, expect, test } from "bun:test";
import { IdempotencyService } from "../../core/security/IdempotencyService";
import { InputPolicy } from "../../core/http/InputPolicy";
import type { Database } from "../../core/database/Database";
import type { SettingsService } from "../../plugins/settings/SettingsService";
import type { $Transaction } from "../../types/database";
import type { receipts } from "../../core/database/schema/receipts";

const service = new IdempotencyService({} as Database, {} as SettingsService);
const hash = (text: string) =>
	new Bun.CryptoHasher("sha256").update(text).digest("hex");

function receiptTransaction(
	receipt: Pick<
		typeof receipts.$inferSelect,
		"fingerprint" | "result" | "secretIssued"
	>,
	expired = false,
) {
	let deleted = false;
	const row = {
		operation: "test",
		principalId: "root",
		key: "key",
		createdAt: new Date("2026-10-01T00:00:00Z"),
		expiresAt: new Date("2026-10-02T00:00:00Z"),
		...receipt,
	};
	const tx = {
		execute: async () => {},
		select: () => ({
			from: () => ({ where: async () => [{ receipt: row, expired }] }),
		}),
		delete: () => ({
			where: async () => {
				deleted = true;
			},
		}),
	};
	return {
		tx: tx as unknown as $Transaction,
		receipt: row,
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
			result: { completed: true },
			secretIssued: null,
		};
		const { tx, receipt: expected } = receiptTransaction(receipt);
		expect(
			await service.existing(
				tx,
				"test",
				"root",
				"key",
				service.fingerprint(reordered),
				reordered,
			),
		).toEqual(expected);
	});

	test("reads a pre-fix receipt without accepting a changed request", async () => {
		const input = { name: "legacy", metadata: { B: 2, a: 1 } };
		// A receipt written before the fix, when locale collation sorted a before B.
		const legacy = hash('{"metadata":{"a":1,"B":2},"name":"legacy"}');
		expect(service.fingerprint(input)).not.toBe(legacy);
		const receipt = {
			fingerprint: legacy,
			result: { completed: true },
			secretIssued: null,
		};
		const { tx, receipt: expected } = receiptTransaction(receipt);
		expect(
			await service.existing(
				tx,
				"test",
				"root",
				"key",
				service.fingerprint(input),
				input,
			),
		).toEqual(expected);
		const changed = { ...input, metadata: { B: 3, a: 1 } };
		await expect(
			service.existing(
				tx,
				"test",
				"root",
				"key",
				service.fingerprint(changed),
				changed,
			),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
	});

	test("legacy compatibility preserves secret and expiry boundaries", async () => {
		const input = { name: "legacy", metadata: { B: 2, a: 1 } };
		const receipt = {
			fingerprint: hash('{"metadata":{"a":1,"B":2},"name":"legacy"}'),
			result: null,
			secretIssued: ["issued-id"],
		};
		await expect(
			service.existing(
				receiptTransaction(receipt).tx,
				"test",
				"root",
				"key",
				service.fingerprint(input),
				input,
			),
		).rejects.toMatchObject({
			status: 409,
			code: "SECRET_ALREADY_ISSUED",
			resourceIds: ["issued-id"],
		});
		const expired = receiptTransaction(receipt, true);
		expect(
			await service.existing(
				expired.tx,
				"test",
				"root",
				"key",
				service.fingerprint(input),
				input,
			),
		).toBeUndefined();
		expect(expired.deleted()).toBe(true);
	});
});
