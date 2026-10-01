import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Database } from "../../core/database/Database";
import { HttpError } from "../../core/http/HttpError";
import { MeterSchedule } from "../../plugins/licenses/MeterSchedule";
import type { $MeterSchedule } from "../../types/meters";

const url = process.env.KZ_TEST_DATABASE_URL;
if (!url)
	throw new Error(
		"KZ_TEST_DATABASE_URL is required for real PostgreSQL schedule tests",
	);
const database = new Database(url, 2);
const scheduler = new MeterSchedule();

beforeAll(async () => {
	await database.ping();
});
afterAll(async () => {
	await database.close();
});

describe("PostgreSQL reset calendar", () => {
	test.each([
		{
			title: "daily before reset",
			schedule: { interval: "day", time: "12:00", timezone: "UTC" },
			now: "2026-09-24T11:59:59.999Z",
			previous: "2026-09-23T12:00:00.000Z",
			next: "2026-09-24T12:00:00.000Z",
		},
		{
			title: "daily exactly at reset",
			schedule: { interval: "day", time: "12:00", timezone: "UTC" },
			now: "2026-09-24T12:00:00.000Z",
			previous: "2026-09-24T12:00:00.000Z",
			next: "2026-09-25T12:00:00.000Z",
		},
		{
			title: "weekly ISO Monday",
			schedule: {
				interval: "week",
				dayOfWeek: 1,
				time: "00:00",
				timezone: "UTC",
			},
			now: "2026-09-24T12:00:00.000Z",
			previous: "2026-09-21T00:00:00.000Z",
			next: "2026-09-28T00:00:00.000Z",
		},
		{
			title: "weekly ISO Sunday",
			schedule: {
				interval: "week",
				dayOfWeek: 7,
				time: "20:00",
				timezone: "UTC",
			},
			now: "2026-09-27T19:00:00.000Z",
			previous: "2026-09-20T20:00:00.000Z",
			next: "2026-09-27T20:00:00.000Z",
		},
		{
			title: "monthly clamps April and returns to May 31",
			schedule: { interval: "month", day: 31, time: "00:00", timezone: "UTC" },
			now: "2026-05-10T00:00:00.000Z",
			previous: "2026-04-30T00:00:00.000Z",
			next: "2026-05-31T00:00:00.000Z",
		},
		{
			title: "monthly clamps February without anchor drift",
			schedule: { interval: "month", day: 31, time: "04:00", timezone: "UTC" },
			now: "2026-03-01T00:00:00.000Z",
			previous: "2026-02-28T04:00:00.000Z",
			next: "2026-03-31T04:00:00.000Z",
		},
		{
			title: "monthly leap February",
			schedule: { interval: "month", day: 31, time: "00:00", timezone: "UTC" },
			now: "2028-02-29T00:00:00.000Z",
			previous: "2028-02-29T00:00:00.000Z",
			next: "2028-03-31T00:00:00.000Z",
		},
		{
			title: "yearly leap anchor clamps in non-leap years",
			schedule: {
				interval: "year",
				month: 2,
				day: 29,
				time: "10:00",
				timezone: "UTC",
			},
			now: "2027-09-24T00:00:00.000Z",
			previous: "2027-02-28T10:00:00.000Z",
			next: "2028-02-29T10:00:00.000Z",
		},
		{
			title: "yearly current boundary across missed years",
			schedule: {
				interval: "year",
				month: 1,
				day: 1,
				time: "00:00",
				timezone: "UTC",
			},
			now: "2042-07-01T00:00:00.000Z",
			previous: "2042-01-01T00:00:00.000Z",
			next: "2043-01-01T00:00:00.000Z",
		},
		{
			title: "DST gap shifts 02:30 forward to 03:30",
			schedule: {
				interval: "day",
				time: "02:30",
				timezone: "America/New_York",
			},
			now: "2026-03-08T07:00:00.000Z",
			previous: "2026-03-07T07:30:00.000Z",
			next: "2026-03-08T07:30:00.000Z",
		},
		{
			title: "DST overlap chooses the later occurrence",
			schedule: {
				interval: "day",
				time: "01:30",
				timezone: "America/New_York",
			},
			now: "2026-11-01T05:45:00.000Z",
			previous: "2026-10-31T05:30:00.000Z",
			next: "2026-11-01T06:30:00.000Z",
		},
		{
			title: "DST overlap boundary advances once",
			schedule: {
				interval: "day",
				time: "01:30",
				timezone: "America/New_York",
			},
			now: "2026-11-01T06:30:00.000Z",
			previous: "2026-11-01T06:30:00.000Z",
			next: "2026-11-02T06:30:00.000Z",
		},
		{
			title: "yearly impossible month day clamps to its last day",
			schedule: {
				interval: "year",
				month: 4,
				day: 31,
				time: "00:00",
				timezone: "UTC",
			},
			now: "2026-04-30T00:00:00.000Z",
			previous: "2026-04-30T00:00:00.000Z",
			next: "2027-04-30T00:00:00.000Z",
		},
		{
			title: "Southern Hemisphere gap",
			schedule: {
				interval: "day",
				time: "02:30",
				timezone: "Australia/Sydney",
			},
			now: "2026-10-03T16:00:00.000Z",
			previous: "2026-10-02T16:30:00.000Z",
			next: "2026-10-03T16:30:00.000Z",
		},
	] satisfies {
		title: string;
		schedule: $MeterSchedule;
		now: string;
		previous: string;
		next: string;
	}[])("$title", async ({ schedule, now, previous, next }) => {
		const reference = new Date(now);
		const result = await database.transaction((tx) =>
			scheduler.boundaries(tx, schedule, reference),
		);
		expect(result.previous.toISOString()).toBe(previous);
		expect(result.next.toISOString()).toBe(next);
		expect(result.previous <= reference && reference < result.next).toBe(true);
	});

	test("connection timezone cannot alter an explicit reset timezone", async () => {
		const result = await database.transaction(async (tx) => {
			await tx.execute(sql`set local timezone = 'Pacific/Auckland'`);
			return scheduler.boundaries(
				tx,
				{ interval: "month", day: 31, time: "00:00", timezone: "UTC" },
				new Date("2026-04-30T00:00:00.000Z"),
			);
		});
		expect(result.previous.toISOString()).toBe("2026-04-30T00:00:00.000Z");
		expect(result.next.toISOString()).toBe("2026-05-31T00:00:00.000Z");
	});

	test("rejects unknown zones, malformed times and interval-specific missing or extra fields", async () => {
		const invalid: $MeterSchedule[] = [
			{ interval: "day", time: "00:00", timezone: "Invalid/Timezone" },
			{ interval: "day", time: "24:00", timezone: "UTC" },
			{ interval: "day", time: "00:00", timezone: "UTC", day: 1 },
			{ interval: "week", time: "00:00", timezone: "UTC" },
			{ interval: "week", time: "00:00", timezone: "UTC", dayOfWeek: 0 },
			{ interval: "month", time: "00:00", timezone: "UTC" },
			{ interval: "month", time: "00:00", timezone: "UTC", day: 31, month: 2 },
			{ interval: "year", time: "00:00", timezone: "UTC", day: 29 },
			{ interval: "year", time: "00:00", timezone: "UTC", day: 29, month: 13 },
		];
		for (const schedule of invalid) {
			await expect(
				database.transaction((tx) => scheduler.validate(tx, schedule)),
			).rejects.toBeInstanceOf(HttpError);
		}
	});
});
