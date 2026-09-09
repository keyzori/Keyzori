import { describe, expect, mock, test } from "bun:test";
import {
	ActivityService,
	sanitizeDetails,
} from "../application/services/ActivityService";
import type { IActivityRepository } from "../domain/repositories/IActivityRepository";

describe("ActivityService", () => {
	test("removes secrets recursively before persistence", async () => {
		const record = mock(async (event) => ({
			id: "event-1",
			type: event.type,
			source: event.source,
			outcome: event.outcome ?? "success",
			reason: event.reason ?? null,
			licenseId: event.licenseId ?? null,
			customerId: event.customerId ?? null,
			keyPrefix: event.keyPrefix ?? null,
			ip: event.ip ?? null,
			deviceId: event.deviceId ?? null,
			details: event.details ?? {},
			createdAt: event.createdAt ?? new Date(),
		}));
		const repository: IActivityRepository = {
			record,
			listDetailed: async () => [],
			getStatistics: async () => ({ totals: [], buckets: [], recent: [] }),
			pruneBefore: async () => 0,
		};
		const service = new ActivityService(repository, () => {});
		await service.capture({
			type: "license.created",
			source: "operator",
			reason: "copied lic_secret by mistake",
			keyPrefix: "lic_12345678901234567890",
			details: {
				licenseKey: "lic_secret",
				nested: { sessionToken: "secret", safe: true },
			},
		});
		const persisted = record.mock.calls[0]?.[0];
		expect(persisted?.keyPrefix).toHaveLength(16);
		expect(persisted?.reason).toBe("[REDACTED]");
		expect(persisted?.details).toEqual({ nested: { safe: true } });
	});

	test("keeps licensing live when persistence fails", async () => {
		const repository: IActivityRepository = {
			record: async () => {
				throw new Error("database unavailable");
			},
			listDetailed: async () => [],
			getStatistics: async () => ({ totals: [], buckets: [], recent: [] }),
			pruneBefore: async () => 0,
		};
		const service = new ActivityService(repository, () => {});
		await expect(
			service.capture({ type: "license.heartbeat", source: "client" }),
		).resolves.toBeNull();
	});

	test("uses configured retention and rejects invalid values", async () => {
		const pruneBefore = mock(async (_before: Date) => 4);
		const repository: IActivityRepository = {
			record: async () => {
				throw new Error("unused");
			},
			listDetailed: async () => [],
			getStatistics: async () => ({ totals: [], buckets: [], recent: [] }),
			pruneBefore,
		};
		const service = new ActivityService(repository);
		const now = new Date("2026-08-15T00:00:00.000Z");
		expect(await service.pruneExpiredActivity(7, now)).toBe(4);
		expect(pruneBefore.mock.calls[0]?.[0]).toEqual(
			new Date("2026-08-08T00:00:00.000Z"),
		);
		expect(service.pruneExpiredActivity(0, now)).rejects.toThrow(
			"positive integer",
		);
	});

	test("sanitizer keeps ordinary structured details", () => {
		expect(sanitizeDetails({ meter: "credits", units: 2 })).toEqual({
			meter: "credits",
			units: 2,
		});
	});
});
