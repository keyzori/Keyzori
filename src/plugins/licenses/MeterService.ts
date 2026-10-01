import { and, asc, eq, sql } from "drizzle-orm";
import { meters } from "../../core/database/schema/meters";
import { HttpError } from "../../core/http/HttpError";
import { Decision } from "../validate/Decision";
import { DecimalPolicy } from "./DecimalPolicy";
import { MeterSchedule } from "./MeterSchedule";
import type { AuditService } from "../audits/AuditService";
import type { EventService } from "../webhooks/EventService";
import type { $Transaction } from "../../types/database";
import type { $Meter, $MeterChanges } from "../../types/meters";
import type { $AuditInput } from "../../types/audit";

export class MeterService {
	private readonly decimal = new DecimalPolicy();
	private readonly calendar = new MeterSchedule();
	constructor(
		private readonly audit: AuditService,
		private readonly events: EventService,
	) {}
	async definitions(
		tx: $Transaction,
		licenseId: string,
		changes: $MeterChanges,
		evidence: $AuditInput,
		now: Date,
	) {
		const upsert = changes.upsert ?? [];
		const remove = changes.remove ?? [];
		const names = upsert.map((entry) => entry.name);
		if (
			new Set(names).size !== names.length ||
			new Set(remove).size !== remove.length ||
			names.some((name) => remove.includes(name))
		)
			throw new HttpError("INVALID_REQUEST");
		const existing = await this.effective(tx, licenseId, evidence, now);
		if (remove.some((name) => !existing.some((row) => row.name === name)))
			throw new HttpError("INVALID_USAGE_METER");
		if (
			existing.length -
				remove.length +
				names.filter((name) => !existing.some((row) => row.name === name))
					.length >
			128
		)
			throw new HttpError("INVALID_REQUEST");
		for (const row of existing.filter((entry) => remove.includes(entry.name))) {
			await tx.delete(meters).where(eq(meters.id, row.id));
			await this.audit.record(tx, {
				...evidence,
				action: "meter.deleted",
				before: this.view(row),
			});
		}
		for (const input of upsert) {
			const current = existing.find((row) => row.name === input.name);
			const mode = input.numericMode ?? current?.numericMode ?? "integer";
			const precision =
				mode === "integer"
					? 0
					: (input.precision ??
						(current?.numericMode === "decimal" ? current.precision : 6));
			if (
				mode === "integer" &&
				input.precision !== undefined &&
				input.precision !== 0
			)
				throw new HttpError("INVALID_REQUEST");
			const reducing = current !== undefined && precision < current.precision;
			if (!reducing) this.decimal.value(input.limit, precision);
			else if (!Number.isFinite(input.limit) || input.limit < 0)
				throw new HttpError("INVALID_REQUEST");
			const schedule =
				input.schedule === undefined
					? (current?.schedule ?? null)
					: input.schedule;
			const nextResetAt = schedule
				? (await this.calendar.boundaries(tx, schedule, now)).next
				: null;
			const [numbers] = await tx
				.select({
					value: sql<string>`trunc(${current?.value ?? "0"}::numeric, ${precision})::text`,
					limit: sql<string>`trunc(${input.limit.toString()}::numeric, ${precision})::text`,
					invalidLimit: sql<boolean>`scale(trim_scale(${input.limit.toString()}::numeric)) > ${reducing ? current.precision : precision} or trunc(${input.limit.toString()}::numeric, ${precision}) >= power(10::numeric, ${15 - precision})`,
					overflow: sql<boolean>`trunc(${current?.value ?? "0"}::numeric, ${precision}) >= power(10::numeric, ${15 - precision})`,
					reached: sql<boolean>`${current?.value ?? "0"}::numeric < ${current?.limit ?? "0"}::numeric and trunc(${current?.value ?? "0"}::numeric, ${precision}) >= trunc(${input.limit.toString()}::numeric, ${precision})`,
				})
				.from(sql`(values (1)) as conversion`);
			if (!numbers) throw new Error("Meter conversion failed");
			if (numbers.overflow || numbers.invalidLimit)
				throw new HttpError("INVALID_REQUEST");
			const values = {
				name: input.name,
				limit: numbers.limit,
				value: numbers.value,
				allowOverage: input.allowOverage ?? current?.allowOverage ?? false,
				numericMode: mode,
				precision,
				schedule,
				nextResetAt:
					current && Bun.deepEquals(schedule, current.schedule, true)
						? current.nextResetAt
						: nextResetAt,
			};
			if (current) {
				const before = this.view(current);
				const [updated] = await tx
					.update(meters)
					.set(values)
					.where(eq(meters.id, current.id))
					.returning();
				if (!updated) throw new Error("Meter disappeared");
				const diff = this.audit.changes(before, this.view(updated));
				if (diff.changed)
					await this.audit.record(tx, {
						...evidence,
						action: "meter.updated",
						before: diff.before,
						after: diff.after,
					});
				if (numbers.reached) {
					await this.audit.record(tx, {
						...evidence,
						action: "meter.limit_reached",
						before,
						after: this.view(updated),
					});
					await this.events.emit(
						tx,
						"meter.limit_reached",
						{
							licenseId,
							meter: updated.name,
							value: updated.value,
							limit: updated.limit,
						},
						now,
					);
				}
			} else {
				const [created] = await tx
					.insert(meters)
					.values({ id: Bun.randomUUIDv7(), licenseId, ...values })
					.returning();
				if (!created) throw new Error("Meter creation failed");
				await this.audit.record(tx, {
					...evidence,
					action: "meter.created",
					after: this.view(created),
				});
			}
		}
	}
	async effective(
		tx: $Transaction,
		licenseId: string,
		evidence: $AuditInput,
		now: Date,
	) {
		const rows = await tx
			.select()
			.from(meters)
			.where(eq(meters.licenseId, licenseId))
			.orderBy(asc(meters.name));
		const effective = [];
		for (const row of rows) {
			if (row.schedule && (!row.nextResetAt || row.nextResetAt <= now)) {
				const boundary = await this.calendar.boundaries(tx, row.schedule, now);
				const [reset] = await tx
					.update(meters)
					.set({
						value: "0",
						nextResetAt: boundary.next,
						lastScheduledResetAt: boundary.previous,
						lastResetAt: now,
					})
					.where(eq(meters.id, row.id))
					.returning();
				if (!reset) throw new Error("Meter reset failed");
				await this.audit.record(tx, {
					...evidence,
					action: "meter.reset",
					before: { name: row.name, value: row.value },
					after: {
						name: row.name,
						value: "0",
						scheduledAt: boundary.previous.toISOString(),
						executedAt: now.toISOString(),
					},
				});
				await this.events.emit(
					tx,
					"meter.reset",
					{ licenseId, meter: row.name, value: "0", limit: row.limit },
					now,
				);
				effective.push(reset);
			} else effective.push(row);
		}
		return effective;
	}
	validateUsage(rows: $Meter[], usage: Record<string, number> = {}) {
		for (const [name, increment] of Object.entries(usage)) {
			const meter = rows.find((row) => row.name === name);
			if (!meter) throw new HttpError("INVALID_USAGE_METER");
			this.decimal.value(increment, meter.precision, true);
		}
	}
	async consume(
		tx: $Transaction,
		rows: $Meter[],
		usage: Record<string, number> | undefined,
		evidence: $AuditInput,
		now: Date,
	) {
		this.validateUsage(rows, usage);
		for (const row of rows) {
			const increment =
				usage && Object.hasOwn(usage, row.name) ? usage[row.name] : undefined;
			const [check] = await tx
				.select({
					denied: sql<boolean>`not ${row.allowOverage} and (${row.value}::numeric >= ${row.limit}::numeric or ${row.value}::numeric + ${increment?.toString() ?? "0"}::numeric > ${row.limit}::numeric)`,
					overflow: sql<boolean>`${row.value}::numeric + ${increment?.toString() ?? "0"}::numeric >= power(10::numeric, ${15 - row.precision})`,
					next: sql<string>`(${row.value}::numeric + ${increment?.toString() ?? "0"}::numeric)::text`,
					reached: sql<boolean>`${row.value}::numeric < ${row.limit}::numeric and ${row.value}::numeric + ${increment?.toString() ?? "0"}::numeric >= ${row.limit}::numeric`,
				})
				.from(sql`(values (1)) as meter_check`);
			if (!check) throw new Error("Meter evaluation failed");
			if (check.denied) throw new Decision("USAGE_LIMIT_REACHED");
			if (check.overflow) throw new HttpError("INVALID_REQUEST");
			if (increment !== undefined) {
				await tx
					.update(meters)
					.set({ value: check.next })
					.where(eq(meters.id, row.id));
				if (check.reached) {
					await this.audit.record(tx, {
						...evidence,
						action: "meter.limit_reached",
						before: { name: row.name, value: row.value },
						after: { name: row.name, value: check.next, limit: row.limit },
					});
					await this.events.emit(
						tx,
						"meter.limit_reached",
						{
							licenseId: row.licenseId,
							meter: row.name,
							value: check.next,
							limit: row.limit,
						},
						now,
					);
				}
			}
		}
	}
	async adjust(
		tx: $Transaction,
		licenseId: string,
		name: string,
		action: "set" | "increment" | "decrement" | "reset",
		value: number | undefined,
		evidence: $AuditInput,
		now: Date,
	) {
		const rows = await this.effective(tx, licenseId, evidence, now);
		const row = rows.find((meter) => meter.name === name);
		if (!row) throw new HttpError("INVALID_USAGE_METER");
		if ((action === "reset") !== (value === undefined))
			throw new HttpError("INVALID_REQUEST");
		const input =
			value === undefined ? "0" : this.decimal.value(value, row.precision);
		const next =
			action === "reset"
				? sql`0`
				: action === "set"
					? sql`${input}::numeric`
					: action === "increment"
						? sql`${row.value}::numeric + ${input}::numeric`
						: sql`greatest(0, ${row.value}::numeric - ${input}::numeric)`;
		const [result] = await tx
			.select({
				next: sql<string>`(${next})::text`,
				changed: sql<boolean>`${next} <> ${row.value}::numeric`,
				overflow: sql<boolean>`${next} >= power(10::numeric, ${15 - row.precision})`,
				reached: sql<boolean>`${row.value}::numeric < ${row.limit}::numeric and ${next} >= ${row.limit}::numeric`,
			})
			.from(sql`(values (1)) as adjustment`);
		if (!result || result.overflow) throw new HttpError("INVALID_REQUEST");
		if (result.changed || action === "reset") {
			await tx
				.update(meters)
				.set({
					value: result.next,
					...(action === "reset" ? { lastResetAt: now } : {}),
				})
				.where(and(eq(meters.licenseId, licenseId), eq(meters.name, name)));
			await this.audit.record(tx, {
				...evidence,
				action: `meter.${action}`,
				before: { name, value: row.value },
				after: { name, value: result.next },
			});
			if (action === "reset" || result.reached)
				await this.events.emit(
					tx,
					action === "reset" ? "meter.reset" : "meter.limit_reached",
					{ licenseId, meter: name, value: result.next, limit: row.limit },
					now,
				);
		}
	}
	view(row: $Meter) {
		return {
			name: row.name,
			value: row.value,
			limit: row.limit,
			allowOverage: row.allowOverage,
			numericMode: row.numericMode,
			precision: row.precision,
			schedule: row.schedule,
			nextResetAt: row.nextResetAt?.toISOString() ?? null,
			lastScheduledResetAt: row.lastScheduledResetAt?.toISOString() ?? null,
			lastResetAt: row.lastResetAt?.toISOString() ?? null,
		};
	}
}
