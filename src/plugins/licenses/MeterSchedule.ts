import { sql } from "drizzle-orm";
import { TypeBoxValidator } from "elysia";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import type { $Transaction } from "../../types/database";
import type { $MeterSchedule } from "../../types/meters";
import { meterModel } from "./meterModel";

export class MeterSchedule {
	private readonly validator = new TypeBoxValidator(meterModel.schedule);

	async validate(tx: $Transaction, schedule: $MeterSchedule) {
		if (!this.validator.Check(schedule)) {
			throw new HttpError("INVALID_REQUEST", {
				schedule: "Invalid reset schedule",
			});
		}
		const timezone = schedule.timezone ?? "UTC";
		const anchorAt = schedule.anchorAt
			? this.anchor(schedule.anchorAt)
			: undefined;
		const needsWeekday = schedule.interval === "week";
		const needsDay =
			schedule.interval === "month" || schedule.interval === "year";
		const needsMonth = schedule.interval === "year";
		if (
			anchorAt
				? [
						schedule.time,
						schedule.dayOfWeek,
						schedule.day,
						schedule.month,
					].some((value) => value !== undefined)
				: schedule.time === undefined ||
					needsWeekday !== (schedule.dayOfWeek !== undefined) ||
					needsDay !== (schedule.day !== undefined) ||
					needsMonth !== (schedule.month !== undefined)
		) {
			throw new HttpError("INVALID_REQUEST", {
				schedule:
					"Use a recurring anchor or the selected interval's calendar fields",
			});
		}
		const [zone] = await tx
			.select({ name: sql<string>`name` })
			.from(sql`pg_timezone_names`)
			.where(sql`name = ${timezone}`)
			.limit(1);
		if (!zone) {
			throw new HttpError("INVALID_REQUEST", {
				timezone: "Unknown reset timezone",
			});
		}
		return { ...schedule, timezone, ...(anchorAt ? { anchorAt } : {}) };
	}

	async boundaries(tx: $Transaction, schedule: $MeterSchedule, now: Date) {
		if (!Number.isFinite(now.getTime()))
			throw new Error("Invalid schedule reference time");
		const normalized = await this.validate(tx, schedule);
		const { timezone, anchorAt } = normalized;
		// Extract from the original local reference, never a previously clamped reset.
		const day = anchorAt
			? sql`extract(day from ${anchorAt}::timestamp)::integer`
			: sql`${schedule.day}::integer`;
		const month = anchorAt
			? sql`extract(month from ${anchorAt}::timestamp)::integer`
			: sql`${schedule.month}::integer`;
		const weekday = anchorAt
			? sql`extract(isodow from ${anchorAt}::timestamp)::integer`
			: sql`${schedule.dayOfWeek}::integer`;
		const time = anchorAt
			? sql`${anchorAt}::timestamp::time`
			: sql`${schedule.time}::time`;
		const instant = now.toISOString();
		let periodStart = sql`local_date + step`;
		let candidateDate = sql`period_start`;
		if (schedule.interval === "week") {
			periodStart = sql`date_trunc('week', local_date::timestamp)::date + step * 7`;
			candidateDate = sql`period_start + (${weekday} - 1)`;
		} else if (schedule.interval === "month") {
			periodStart = sql`(date_trunc('month', local_date::timestamp) + make_interval(months => step))::date`;
		} else if (schedule.interval === "year") {
			periodStart = sql`make_date(extract(year from local_date)::integer + step, ${month}, 1)`;
		}
		if (schedule.interval === "month" || schedule.interval === "year") {
			candidateDate = sql`period_start + (least(${day},
				extract(day from period_start + interval '1 month - 1 day')::integer) - 1)`;
		}
		const [result] = await tx
			.select({
				previous: sql<string | null>`to_char(
				max(occurrence) filter (where occurrence <= ${instant}::timestamptz) at time zone 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
				next: sql<string | null>`to_char(
				min(occurrence) filter (where occurrence > ${instant}::timestamptz) at time zone 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
			})
			.from(sql`(
			with reference as (
				select (${instant}::timestamptz at time zone ${timezone})::date as local_date
			), periods as (
				select ${periodStart} as period_start
				from reference cross join generate_series(-2, 2) as offsets(step)
			), dates as (
				select ${candidateDate} as candidate_date from periods
			)
			select (candidate_date + ${time}) at time zone ${timezone} as occurrence
			from dates
		) as candidates`);
		const previous = this.date(result?.previous);
		const next = this.date(result?.next);
		if (previous > now || next <= now)
			throw new Error("Reset schedule did not bracket the reference time");
		return { previous, next };
	}

	private anchor(value: string) {
		// Validate the calendar fields without applying any timezone/DST conversion.
		const date = new InputPolicy().timestamp(`${value}Z`);
		const canonical = date.toISOString().slice(0, -1);
		const [whole, fraction = ""] = value.split(".");
		if (canonical !== `${whole}.${fraction.padEnd(3, "0")}`)
			throw new HttpError("INVALID_REQUEST", {
				anchorAt: "Invalid local calendar reference",
			});
		return canonical;
	}

	private date(value: unknown) {
		if (typeof value !== "string")
			throw new Error("Reset schedule returned an invalid boundary");
		const date = new Date(value);
		if (!Number.isFinite(date.getTime()))
			throw new Error("Reset schedule returned an invalid boundary");
		return date;
	}
}
