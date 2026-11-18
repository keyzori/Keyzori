import { eq, and, inArray } from "drizzle-orm";
import { LicenseView, summaryColumns } from "./LicenseView";
import { writeInstant } from "../../core/http/instant";
import { deletionColumns } from "./LicenseCascade";
import { LicenseContext } from "./LicenseContext";
import { LicenseUsage } from "./LicenseUsage";
import { LicenseRegistrations } from "./LicenseRegistrations";
import { Eligibility } from "../validate/Eligibility";
import { licenses } from "../../core/database/schema/licenses";
import { users } from "../../core/database/schema/users";
import { groups } from "../../core/database/schema/groups";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { SecretHasher } from "../../core/security/SecretHasher";
import type { Database } from "../../core/database/Database";
import type { AuthService } from "../../core/auth/AuthService";
import type { ClientIpResolver } from "../../core/http/ClientIpResolver";
import type { AuditService } from "../audits/AuditService";
import type { EventService } from "../webhooks/EventService";
import type { SettingsService } from "../settings/SettingsService";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type { MeterService } from "./MeterService";
import type { LicenseDeletion } from "./LicenseDeletion";
import type {
	$License,
	$LicenseCreate,
	$LicenseUpdate,
	$LicenseAction,
	$LicenseRotate,
	$LicenseDelete,
	$MeterAdjustment,
	$HardwareRemoval,
	$IpRemoval,
	$UsageConsume,
	$Registration,
} from "../../types/licenses";
import type { $Operation } from "../../types/operation";
import type { $Transaction } from "../../types/database";

export class LicenseService {
	private readonly input = new InputPolicy();
	private readonly keys = new KeyGenerator();
	private readonly hashes = new SecretHasher();
	private readonly context: LicenseContext;
	private readonly usage: LicenseUsage;
	private readonly registrations: LicenseRegistrations;
	constructor(
		private readonly database: Database,
		private readonly auth: AuthService,
		private readonly audit: AuditService,
		private readonly events: EventService,
		private readonly settings: SettingsService,
		private readonly idempotency: IdempotencyService,
		private readonly meters: MeterService,
		private readonly deletion: LicenseDeletion,
		private readonly ip: ClientIpResolver,
	) {
		this.context = new LicenseContext(auth);
		this.usage = new LicenseUsage(
			database,
			auth,
			audit,
			events,
			idempotency,
			meters,
			new Eligibility(settings, ip),
			this.context,
		);
		this.registrations = new LicenseRegistrations(
			auth,
			audit,
			idempotency,
			ip,
			this.context,
		);
	}
	async create(input: $LicenseCreate, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:create");
		this.checkInput(input);
		const targets = this.context.targets(
			operation,
			"licenses:create",
			[],
			{ id: licenses.id },
			input.groupId ?? null,
			input.userId,
		);
		return this.idempotency.admin(
			operation,
			"license.create",
			input,
			async (tx, now) => {
				await this.relations(tx, input);
				const format = await this.format(tx, input.groupId);
				for (let attempt = 0; attempt < 5; attempt++) {
					const credential = this.keys.license(format);
					const [row] = await tx
						.insert(licenses)
						.values({
							id: Bun.randomUUIDv7(),
							keyHash: this.hashes.hash(credential),
							keyFormat: format,
							userId: input.userId,
							groupId: input.groupId,
							expiresAt:
								input.expiresAt == null ? null : writeInstant(input.expiresAt),
							deviceLimit: input.deviceLimit,
							ipLimit: input.ipLimit,
							allowedIps: input.allowedIps ?? [],
							metadata: input.metadata ?? {},
							notes: input.notes,
							createdBy: operation.principal.id,
							updatedBy: operation.principal.id,
						})
						.onConflictDoNothing({ target: licenses.keyHash })
						.returning();
					if (!row) continue;
					if (input.meters)
						await this.meters.definitions(
							tx,
							row.id,
							input.meters,
							this.context.evidence(operation, row.id),
							now,
						);
					const { principal } = targets.state(tx);
					const data =
						principal.kind === "root" ||
						principal.scopes.includes("licenses:read")
							? await new LicenseView(this.meters).read(tx, row, now)
							: { id: row.id };
					await this.audit.record(tx, {
						...this.context.evidence(operation, row.id),
						action: "license.created",
						groupId: row.groupId,
						after: {
							id: row.id,
							enabled: row.enabled,
							keyFormat: row.keyFormat,
							...this.fields(row),
						},
					});
					await this.events.emit(
						tx,
						"license.created",
						{ licenseId: row.id },
						now,
					);
					return { data, credential };
				}
				throw new Error("Credential generation collision limit reached");
			},
			{
				secretIds: (result) => [result.data.id],
				authorize: targets.authorize,
			},
		);
	}
	async read(params: URLSearchParams, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:read");
		return this.database.transaction(
			async (tx) => {
				const principal = await this.auth.authorize(
					tx,
					operation.principal,
					"licenses:read",
				);
				const settings = await this.settings.read(tx);
				const query = new ResourceQuery(
					params,
					licenses,
					settings.defaultPageLimit,
				);
				const visible = and(
					query.where,
					this.auth.groupFilter(principal, licenses.groupId),
				);
				// A detail projection reads several child tables. All child mutations
				// take the licence lock, so this also freezes its group authority.
				const view = new LicenseView(this.meters);
				if (query.id) {
					const [row] = await tx
						.select()
						.from(licenses)
						.where(visible)
						.limit(1)
						.for("share");
					if (!row) throw new HttpError("NOT_FOUND");
					return { data: await view.read(tx, row, await this.context.now(tx)) };
				}
				const rows = await tx
					.select(summaryColumns)
					.from(licenses)
					.where(visible)
					.orderBy(...query.order)
					.limit(query.limit + 1);
				const selected = rows.slice(0, query.limit);
				const last = selected.at(-1);
				return {
					data: selected.map((row) => view.summary(row)),
					pageLimit: query.limit,
					nextCursor:
						rows.length > query.limit && last ? query.cursor(last) : null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	async update(input: $LicenseUpdate, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:update");
		input = {
			...input,
			changes: {
				...input.changes,
				...(input.changes.groupId
					? { groupId: input.changes.groupId.toLowerCase() }
					: {}),
				...(input.changes.userId
					? { userId: input.changes.userId.toLowerCase() }
					: {}),
			},
		};
		this.checkInput(input.changes);
		const ids = this.input.ids(input.ids);
		const targets = this.context.targets(
			operation,
			"licenses:update",
			ids,
			{
				id: licenses.id,
				userId: licenses.userId,
				groupId: licenses.groupId,
				enabled: licenses.enabled,
				expiresAt: licenses.expiresAt,
				deviceLimit: licenses.deviceLimit,
				ipLimit: licenses.ipLimit,
				allowedIps: licenses.allowedIps,
				metadata: licenses.metadata,
				notes: licenses.notes,
			},
			input.changes.groupId,
			input.changes.userId,
		);
		return this.idempotency.admin(
			operation,
			"license.update",
			input,
			async (tx) => {
				const { rows: locked, principal } = targets.state(tx);
				const now = await this.context.now(tx, principal);
				await this.relations(tx, input.changes);
				await this.checkReparent(tx, locked, input.changes);
				const {
					meters: definitions,
					expiresAt,
					allowedIps,
					...other
				} = input.changes;
				const changes = {
					...other,
					...(allowedIps !== undefined
						? { allowedIps: await this.ip.canonicalRules(tx, allowedIps) }
						: {}),
				};
				const expiry = expiresAt == null ? expiresAt : writeInstant(expiresAt);
				for (const row of locked) {
					const before = this.fields(row);
					const candidate = {
						...before,
						...changes,
						...(expiry !== undefined
							? { expiresAt: expiry?.toISOString() ?? null }
							: {}),
					};
					const diff = this.audit.changes(before, candidate);
					const moved = candidate.groupId !== row.groupId;
					const historicalAuthority = {
						requiredGroupIds: moved
							? [row.groupId, candidate.groupId].filter(
									(id): id is string => id !== null,
								)
							: [],
						requiresAllGroups:
							moved && (row.groupId === null || candidate.groupId === null),
					};
					if (diff.changed) {
						await tx
							.update(licenses)
							.set({
								...changes,
								...(expiry !== undefined ? { expiresAt: expiry } : {}),
								updatedBy: operation.principal.id,
								updatedAt: now,
							})
							.where(eq(licenses.id, row.id));
						await this.audit.record(tx, {
							...this.context.evidence(operation, row.id, input.reason),
							action: "license.updated",
							groupId: row.groupId,
							...historicalAuthority,
							before: diff.before,
							after: diff.after,
						});
						if (moved) {
							await this.events.emit(
								tx,
								"license.group_detached",
								{ licenseId: row.id, groupId: row.groupId },
								now,
							);
							await this.events.emit(
								tx,
								"license.group_attached",
								{ licenseId: row.id, groupId: candidate.groupId },
								now,
							);
						}
						await this.events.emit(
							tx,
							"license.updated",
							{ licenseId: row.id },
							now,
						);
					}
					if (definitions)
						await this.meters.definitions(
							tx,
							row.id,
							definitions,
							{
								...this.context.evidence(operation, row.id, input.reason),
								groupId: candidate.groupId,
								...historicalAuthority,
							},
							now,
						);
				}
				return { data: { ids } };
			},
			{
				authorize: async (tx) => {
					const principal = await targets.authorize(tx);
					if (input.changes.meters)
						this.auth.require(principal, "usage:adjust");
					return principal;
				},
			},
		);
	}
	async enable(input: $LicenseAction, operation: $Operation) {
		return this.setEnabled(input, operation, true);
	}
	async disable(input: $LicenseAction, operation: $Operation) {
		return this.setEnabled(input, operation, false);
	}
	private async setEnabled(
		input: $LicenseAction,
		operation: $Operation,
		enabled: boolean,
	) {
		const action = enabled ? "enable" : "disable";
		this.auth.require(operation.principal, `licenses:${action}`);
		const ids = this.input.ids(input.ids);
		const targets = this.context.targets(operation, `licenses:${action}`, ids, {
			id: licenses.id,
			enabled: licenses.enabled,
			disabledReason: licenses.disabledReason,
		});
		return this.idempotency.admin(
			operation,
			`license.${action}`,
			input,
			async (tx) => {
				const { rows: locked, principal } = targets.state(tx);
				const now = await this.context.now(tx, principal);
				for (const row of locked) {
					const after = {
						enabled,
						disabledReason: enabled ? null : (input.reason ?? null),
					};
					const diff = this.audit.changes(
						{ enabled: row.enabled, disabledReason: row.disabledReason },
						after,
					);
					if (!diff.changed) continue;
					await tx
						.update(licenses)
						.set({
							...after,
							updatedAt: now,
							updatedBy: operation.principal.id,
						})
						.where(eq(licenses.id, row.id));
					await this.audit.record(tx, {
						...this.context.evidence(operation, row.id, input.reason),
						action: `license.${enabled ? "enabled" : "disabled"}`,
						before: diff.before,
						after: diff.after,
					});
					await this.events.emit(
						tx,
						enabled ? "license.enabled" : "license.disabled",
						{ licenseId: row.id },
						now,
					);
				}
				return { data: { ids } };
			},
			{
				authorize: targets.authorize,
			},
		);
	}
	async delete(input: $LicenseDelete, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:delete");
		if (input.confirm !== true || !input.reason)
			throw new HttpError("INVALID_REQUEST");
		const ids = this.input.ids(input.ids);
		const targets = this.context.targets(
			operation,
			"licenses:delete",
			ids,
			deletionColumns,
		);
		return this.idempotency.admin(
			operation,
			"license.delete",
			input,
			async (tx) => {
				const { rows, principal } = targets.state(tx);
				await this.deletion.remove(
					tx,
					rows,
					operation,
					input.reason,
					await this.context.now(tx, principal),
				);
				return { data: { ids } };
			},
			{
				scope: "licenses:delete",
				authority: async (tx) => ({
					groupIds: targets.state(tx).rows.map((row) => row.groupId),
				}),
				authorize: targets.authorize,
			},
		);
	}
	async rotate(input: $LicenseRotate, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:rotate");
		const ids = this.input.ids(input.ids);
		const targets = this.context.targets(operation, "licenses:rotate", ids, {
			id: licenses.id,
			groupId: licenses.groupId,
			keyFormat: licenses.keyFormat,
			keyHash: licenses.keyHash,
		});
		return this.idempotency.admin(
			operation,
			"license.rotate",
			input,
			async (tx) => {
				const { rows: locked, principal } = targets.state(tx);
				const now = await this.context.now(tx, principal);
				const data = [];
				for (const row of locked) {
					const format = await this.format(tx, row.groupId);
					let credential = "";
					for (let attempt = 0; attempt < 5; attempt++) {
						const candidate = this.keys.license(format);
						if (this.hashes.hash(candidate) === row.keyHash) continue;
						try {
							await tx.transaction(async (savepoint) => {
								await savepoint
									.update(licenses)
									.set({
										keyHash: this.hashes.hash(candidate),
										keyFormat: format,
										updatedBy: operation.principal.id,
										updatedAt: now,
									})
									.where(eq(licenses.id, row.id));
							});
							credential = candidate;
							break;
						} catch (error) {
							if (!this.keyCollision(error)) throw error;
						}
					}
					if (!credential)
						throw new Error("Credential generation collision limit reached");
					await this.audit.record(tx, {
						...this.context.evidence(operation, row.id, input.reason),
						action: "license.rotated",
						before: { keyFormat: row.keyFormat },
						after: { keyFormat: format },
					});
					await this.events.emit(
						tx,
						"license.rotated",
						{ licenseId: row.id },
						now,
					);
					data.push({ id: row.id, credential });
				}
				return { data };
			},
			{
				secretIds: (result) => result.data.map((row) => row.id),
				authorize: targets.authorize,
			},
		);
	}
	adjust(input: $MeterAdjustment, operation: $Operation) {
		return this.usage.adjust(input, operation);
	}
	removeHardware(input: $HardwareRemoval, operation: $Operation) {
		return this.registrations.removeHardware(input, operation);
	}
	removeIps(input: $IpRemoval, operation: $Operation) {
		return this.registrations.removeIps(input, operation);
	}
	consume(input: $UsageConsume, operation: $Operation) {
		return this.usage.consume(input, operation);
	}
	register(input: $Registration, operation: $Operation, kind: "device" | "ip") {
		return this.registrations.register(input, operation, kind);
	}

	private fields(
		row: Pick<
			$License,
			| "userId"
			| "groupId"
			| "expiresAt"
			| "deviceLimit"
			| "ipLimit"
			| "allowedIps"
			| "metadata"
			| "notes"
		>,
	) {
		return {
			userId: row.userId,
			groupId: row.groupId,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			deviceLimit: row.deviceLimit,
			ipLimit: row.ipLimit,
			allowedIps: row.allowedIps,
			metadata: row.metadata,
			notes: row.notes,
		};
	}
	private checkInput(input: $LicenseCreate) {
		this.input.metadata(input.metadata);
		this.input.notes(input.notes);
		if (input.allowedIps) this.ip.validateRules(input.allowedIps);
	}
	private async checkReparent(
		tx: $Transaction,
		rows: Pick<$License, "groupId" | "userId" | "enabled">[],
		changes: $LicenseCreate,
	) {
		for (const field of ["groupId", "userId"] as const) {
			if (changes[field] === undefined) continue;
			const ids = [
				...new Set(
					rows.flatMap((row) => {
						const source = row[field];
						return row.enabled && source && source !== changes[field]
							? [source]
							: [];
					}),
				),
			];
			if (!ids.length) continue;
			const parents = field === "groupId" ? groups : users;
			const enabled = await tx
				.select({ id: parents.id })
				.from(parents)
				.where(and(inArray(parents.id, ids), eq(parents.enabled, true)));
			if (enabled.length !== ids.length)
				throw new HttpError("CONFLICT", {
					[field]: "Disable the licence before moving it off a disabled parent",
				});
		}
	}
	private async relations(tx: $Transaction, input: $LicenseCreate) {
		if (
			input.userId &&
			!(
				await tx
					.select({ id: users.id })
					.from(users)
					.where(eq(users.id, input.userId))
			).length
		)
			throw new HttpError("NOT_FOUND");
		if (
			input.groupId &&
			!(
				await tx
					.select({ id: groups.id })
					.from(groups)
					.where(eq(groups.id, input.groupId))
			).length
		)
			throw new HttpError("NOT_FOUND");
	}
	private async format(tx: $Transaction, groupId?: string | null) {
		const settings = await this.settings.read(tx);
		if (!settings.globalFormatEnabled && groupId) {
			const [group] = await tx
				.select({ keyFormat: groups.keyFormat })
				.from(groups)
				.where(eq(groups.id, groupId));
			if (group?.keyFormat) return group.keyFormat;
		}
		return settings.globalKeyFormat;
	}
	private keyCollision(error: unknown, depth = 0): boolean {
		if (!error || typeof error !== "object" || depth > 5) return false;
		const duplicate =
			("code" in error && error.code === "23505") ||
			("errno" in error && error.errno === "23505");
		const constraint =
			"constraint" in error
				? error.constraint
				: "constraint_name" in error
					? error.constraint_name
					: undefined;
		if (
			duplicate &&
			(constraint === "licenses_key_hash_key" ||
				constraint === "licenses_keyHash_unique")
		)
			return true;
		return "cause" in error && this.keyCollision(error.cause, depth + 1);
	}
}
