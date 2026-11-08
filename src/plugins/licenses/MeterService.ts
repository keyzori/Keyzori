import { and, asc, eq, sql } from "drizzle-orm";
import { TypeBoxValidator } from "elysia";
import { meters } from "../../core/database/schema/meters";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import { DecimalPolicy } from "./DecimalPolicy";
import { MeterSchedule } from "./MeterSchedule";
import { meterModel } from "./meterModel";
import type { AuditService } from "../audits/AuditService";
import type { EventService } from "../webhooks/EventService";
import type { $Transaction } from "../../types/database";
import type {
	$Meter,
	$MeterChanges,
	$MeterView,
	$UsageEntry,
} from "../../types/meters";
import type { $AuditInput } from "../../types/audit";

export class MeterService {
	private readonly validator = new TypeBoxValidator(meterModel.changes);
	private readonly input = new InputPolicy();
	constructor(
		private readonly audit: AuditService,
		private readonly events: EventService,
		private readonly decimal = new DecimalPolicy(),
		private readonly calendar = new MeterSchedule(),
	) {}

	async definitions(
		tx: $Transaction,
		licenseId: string,
		changes: $MeterChanges,
		evidence: $AuditInput,
		now: Date,
	) {
		if (!this.validator.Check(changes)) throw new HttpError("INVALID_REQUEST");
		this.input.jsonText(changes);
		const upsert = changes.upsert ?? [];
		const remove = changes.remove ?? [];
		const names = upsert.map((entry) => entry.name);
		if (
			upsert.length > 128 ||
			remove.length > 128 ||
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
			await this.events.emit(
				tx,
				"meter.deleted",
				this.event(row, evidence),
				now,
				this.visibility(evidence),
			);
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
			const suppliedLimit =
				input.limit === undefined ? (current?.limit ?? null) : input.limit;
			const limit =
				suppliedLimit === null
					? null
					: this.decimal.value(suppliedLimit, precision);
			const suppliedSchedule =
				input.schedule === undefined
					? (current?.schedule ?? null)
					: input.schedule;
			const schedule = suppliedSchedule
				? await this.calendar.validate(tx, suppliedSchedule)
				: null;
			const startsAt =
				input.startsAt === undefined
					? (current?.startsAt ?? null)
					: input.startsAt === null
						? null
						: this.input.timestamp(input.startsAt);
			// Changing precision must be explicit and cannot silently discard recorded usage.
			if (current) this.decimal.value(current.value, precision);
			const configuration = {
				name: input.name,
				limit,
				numericMode: mode,
				precision,
				schedule,
				startsAt,
			};
			if (
				current &&
				Bun.deepEquals(configuration, this.configuration(current), true)
			)
				continue;
			const sameSchedule =
				current && Bun.deepEquals(schedule, current.schedule, true);
			const boundary =
				schedule && !sameSchedule
					? await this.calendar.boundaries(tx, schedule, now)
					: null;
			const values = {
				...configuration,
				periodStartedAt: sameSchedule
					? current.periodStartedAt
					: (boundary?.previous ?? null),
				nextResetAt: sameSchedule
					? current.nextResetAt
					: (boundary?.next ?? null),
			};
			const [row] = current
				? await tx
						.update(meters)
						.set({
							...values,
							definitionRevision: sql`${meters.definitionRevision} + 1`,
						})
						.where(eq(meters.id, current.id))
						.returning()
				: await tx
						.insert(meters)
						.values({ id: Bun.randomUUIDv7(), licenseId, ...values })
						.returning();
			if (!row) throw new Error("Meter definition returned no record");
			const diff = this.audit.changes(
				current ? this.view(current) : {},
				this.view(row),
			);
			if (diff.changed)
				await this.audit.record(tx, {
					...evidence,
					action: current ? "meter.updated" : "meter.created",
					before: diff.before,
					after: diff.after,
				});
			await this.events.emit(
				tx,
				current ? "meter.updated" : "meter.created",
				this.event(row, evidence),
				now,
				this.visibility(evidence),
			);
			await this.limitCrossing(tx, current, row, evidence, now);
		}
	}

	/** Presents overdue periods without changing stored counters or audit history. */
	async projection(tx: $Transaction, row: $Meter, now: Date) {
		return this.project(tx, row, now);
	}

	/** One read shares schedule calculations at one database instant, never across reads. */
	async projectMany(tx: $Transaction, rows: $Meter[], now: Date) {
		const boundaries = new Map<
			string,
			Awaited<ReturnType<MeterSchedule["boundaries"]>>
		>();
		const projected = [];
		for (const row of rows)
			projected.push(await this.project(tx, row, now, boundaries));
		return projected;
	}

	private async project(
		tx: $Transaction,
		row: $Meter,
		now: Date,
		boundaries?: Map<string, Awaited<ReturnType<MeterSchedule["boundaries"]>>>,
	) {
		if (!row.schedule || (row.nextResetAt && row.nextResetAt > now))
			return this.view(row);
		// Include every stored field so malformed schedules cannot reuse a valid
		// schedule's result and bypass validation. Property order is immaterial.
		const key = JSON.stringify(
			Object.entries(row.schedule).sort(([a], [b]) => a.localeCompare(b)),
		);
		let boundary = boundaries?.get(key);
		if (!boundary) {
			boundary = await this.calendar.boundaries(tx, row.schedule, now);
			boundaries?.set(key, boundary);
		}
		return this.view({
			...row,
			value: "0",
			periodStartedAt: boundary.previous,
			nextResetAt: boundary.next,
			lastScheduledResetAt: boundary.previous,
		});
	}

	/** Caller holds the licence row lock before applying scheduled resets. */
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
		const effective: $Meter[] = [];
		for (const row of rows) {
			if (!row.schedule || (row.nextResetAt && row.nextResetAt > now)) {
				effective.push(row);
				continue;
			}
			const boundary = await this.calendar.boundaries(tx, row.schedule, now);
			const [reset] = await tx
				.update(meters)
				.set({
					value: "0",
					periodStartedAt: boundary.previous,
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
				before: this.view(row),
				after: {
					...this.view(reset),
					scheduledAt: boundary.previous.toISOString(),
					executedAt: now.toISOString(),
				},
			});
			await this.events.emit(
				tx,
				"meter.reset",
				this.event(reset, evidence),
				now,
				this.visibility(evidence),
			);
			effective.push(reset);
		}
		return effective;
	}

	validateUsage(rows: $Meter[], usage: Record<string, string>, now?: Date) {
		if (!usage || typeof usage !== "object" || Array.isArray(usage))
			throw new HttpError("INVALID_REQUEST");
		const entries = Object.entries(usage);
		if (entries.length === 0 || entries.length > 128)
			throw new HttpError("INVALID_REQUEST");
		for (const [name, increment] of entries) {
			const meter = rows.find((row) => row.name === name);
			if (!meter) throw new HttpError("INVALID_USAGE_METER");
			this.decimal.value(increment, meter.precision, true);
			if (now && meter.startsAt && now < meter.startsAt)
				throw new HttpError("CONFLICT", {
					usage: `Counter ${name} has not started`,
				});
		}
	}

	/** Every requested increment succeeds in the surrounding transaction, or none do. */
	async consume(
		tx: $Transaction,
		rows: $Meter[],
		usage: Record<string, string>,
		evidence: $AuditInput,
		now: Date,
	) {
		this.validateUsage(rows, usage, now);
		const entries: $UsageEntry[] = [];
		for (const row of rows) {
			const increment = Object.hasOwn(usage, row.name)
				? usage[row.name]
				: undefined;
			if (increment === undefined) continue;
			const delta = this.decimal.value(increment, row.precision, true);
			const next = sql`${meters.value} + ${delta}::numeric`;
			const [updated] = await tx
				.update(meters)
				.set({ value: next })
				.where(
					and(
						eq(meters.id, row.id),
						eq(meters.value, row.value),
						eq(meters.definitionRevision, row.definitionRevision),
						eq(meters.resetGeneration, row.resetGeneration),
						sql`(${meters.limit} is null or ${next} <= ${meters.limit}) and ${next} < power(10::numeric, ${15 - row.precision})`,
					),
				)
				.returning();
			if (!updated)
				throw new HttpError("CONFLICT", {
					usage: `Counter ${row.name} would exceed its limit or numeric range`,
				});
			entries.push({
				...this.identity(updated),
				name: row.name,
				delta,
				before: this.decimal.value(row.value, row.precision),
				after: this.decimal.value(updated.value, row.precision),
				limit:
					row.limit === null
						? null
						: this.decimal.value(row.limit, row.precision),
			});
			await this.limitCrossing(tx, row, updated, evidence, now);
		}
		return entries;
	}

	async adjust(
		tx: $Transaction,
		licenseId: string,
		name: string,
		action: "set" | "increment" | "decrement" | "reset",
		value: string | undefined,
		evidence: $AuditInput,
		now: Date,
	) {
		if (!["set", "increment", "decrement", "reset"].includes(action))
			throw new HttpError("INVALID_REQUEST");
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
						? sql`${meters.value} + ${input}::numeric`
						: sql`greatest(0, ${meters.value} - ${input}::numeric)`;
		const [updated] = await tx
			.update(meters)
			.set({
				value: next,
				...(action === "reset"
					? {
							lastResetAt: now,
							resetGeneration: sql`${meters.resetGeneration} + 1`,
						}
					: {}),
			})
			.where(
				and(
					eq(meters.id, row.id),
					sql`${next} < power(10::numeric, ${15 - row.precision})`,
				),
			)
			.returning();
		if (!updated) throw new HttpError("INVALID_REQUEST");
		if (
			this.decimal.value(updated.value, row.precision) !==
				this.decimal.value(row.value, row.precision) ||
			action === "reset"
		) {
			await this.audit.record(tx, {
				...evidence,
				action: `meter.${action}`,
				before: this.view(row),
				after: this.view(updated),
			});
			await this.events.emit(
				tx,
				action === "reset" ? "meter.reset" : "meter.adjusted",
				this.event(updated, evidence),
				now,
				this.visibility(evidence),
			);
			await this.limitCrossing(tx, row, updated, evidence, now);
		}
	}

	private configuration(row: $Meter) {
		return {
			name: row.name,
			limit:
				row.limit === null
					? null
					: this.decimal.value(row.limit, row.precision),
			numericMode: row.numericMode,
			precision: row.precision,
			schedule: row.schedule,
			startsAt: row.startsAt,
		};
	}

	private identity(row: $Meter) {
		const periodStartedAt = row.periodStartedAt?.toISOString() ?? null;
		return {
			counterId: row.id,
			definitionRevision: row.definitionRevision,
			resetGeneration: row.resetGeneration,
			periodId: `${row.id}:${row.definitionRevision}:${row.resetGeneration}:${periodStartedAt ?? "lifetime"}`,
			periodStartedAt,
			periodEndsAt: row.nextResetAt?.toISOString() ?? null,
		};
	}

	private event(row: $Meter, evidence: $AuditInput) {
		return {
			...this.identity(row),
			licenseId: row.licenseId,
			...(evidence.groupId !== undefined ? { groupId: evidence.groupId } : {}),
			meter: row.name,
			value: this.decimal.value(row.value, row.precision),
			limit:
				row.limit === null
					? null
					: this.decimal.value(row.limit, row.precision),
		};
	}

	/** Historical authority belongs in internal routing metadata, never the payload. */
	private visibility(evidence: $AuditInput) {
		return {
			requiredGroupIds: evidence.requiredGroupIds,
			requiresAllGroups: evidence.requiresAllGroups,
		};
	}

	/** Definition changes and administrative adjustments can also cross a limit. */
	private async limitCrossing(
		tx: $Transaction,
		before: $Meter | undefined,
		after: $Meter,
		evidence: $AuditInput,
		now: Date,
	) {
		if (after.limit === null) return;
		const [result] = await tx
			.select({
				crossed: sql<boolean>`(${before?.limit ?? null}::numeric is null or ${before?.value ?? "0"}::numeric < ${before?.limit ?? null}::numeric) and ${after.value}::numeric >= ${after.limit}::numeric`,
			})
			.from(sql`(values (1)) as comparison`);
		if (result?.crossed)
			await this.events.emit(
				tx,
				"meter.limit_reached",
				{
					...this.event(after, evidence),
					limit: this.decimal.value(after.limit, after.precision),
				},
				now,
				this.visibility(evidence),
			);
	}

	view(row: $Meter): $MeterView {
		return {
			...this.configuration(row),
			...this.identity(row),
			value: this.decimal.value(row.value, row.precision),
			startsAt: row.startsAt?.toISOString() ?? null,
			nextResetAt: row.nextResetAt?.toISOString() ?? null,
			lastScheduledResetAt: row.lastScheduledResetAt?.toISOString() ?? null,
			lastResetAt: row.lastResetAt?.toISOString() ?? null,
		};
	}
}
