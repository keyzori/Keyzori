import { asc, eq, inArray, and, sql } from "drizzle-orm";
import { licenses } from "../../core/database/schema/licenses";
import { users } from "../../core/database/schema/users";
import { items } from "../../core/database/schema/items";
import { hardware } from "../../core/database/schema/hardware";
import { ips } from "../../core/database/schema/ips";
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
	$LicenseAdmin,
	$LicenseCreate,
	$LicenseUpdate,
	$LicenseAction,
	$LicenseRotate,
	$LicenseDelete,
	$MeterAdjustment,
	$HardwareRemoval,
	$IpRemoval,
} from "../../types/licenses";
import type { $Operation } from "../../types/operation";
import type { $Transaction } from "../../types/database";

export class LicenseService {
	private readonly input = new InputPolicy();
	private readonly keys = new KeyGenerator();
	private readonly hashes = new SecretHasher();
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
	) {}
	async create(input: $LicenseCreate, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:create");
		this.checkInput(input);
		return this.idempotency.admin(
			operation,
			"license.create",
			input,
			async (tx, now) => {
				await this.relations(tx, input);
				const format = await this.format(tx, input.itemId);
				for (let attempt = 0; attempt < 5; attempt++) {
					const credential = this.keys.license(format);
					const [row] = await tx
						.insert(licenses)
						.values({
							id: Bun.randomUUIDv7(),
							keyHash: this.hashes.hash(credential),
							keyFormat: format,
							userId: input.userId,
							itemId: input.itemId,
							expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
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
							this.evidence(operation, row.id),
							now,
						);
					const data = await this.view(tx, row, operation, now);
					await this.audit.record(tx, {
						...this.evidence(operation, row.id),
						action: "license.created",
						after: data,
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
			{ secretIds: (result) => [result.data.id] },
		);
	}
	async read(params: URLSearchParams, operation: $Operation, self = false) {
		this.auth.require(operation.principal, self ? "self" : "licenses:read");
		if (operation.principal.kind === "license") {
			if (self) {
				if (params.size) throw new HttpError("INVALID_REQUEST");
				params = new URLSearchParams({ id: operation.principal.id });
			}
			if (params.get("id") !== operation.principal.id || params.size !== 1)
				throw new HttpError("FORBIDDEN");
		}
		const settings = await this.settings.read(undefined, operation.deadlineAt);
		const query = new ResourceQuery(
			params,
			licenses,
			settings.defaultPageLimit,
		);
		return this.database.transaction(
			async (tx) => {
				const chosen = await tx
					.select()
					.from(licenses)
					.where(query.where)
					.orderBy(...query.order)
					.limit(query.id ? 1 : query.limit + 1);
				if (query.id && !chosen.length) throw new HttpError("NOT_FOUND");
				const rows = chosen.slice(0, query.limit);
				const locked = rows.length
					? await this.lock(
							tx,
							rows.map((row) => row.id),
						)
					: [];
				await this.auth.assertLicense(tx, operation.principal);
				const now = await this.now(tx);
				const data = [];
				for (const row of rows) {
					const current = locked.find((candidate) => candidate.id === row.id);
					if (current) data.push(await this.view(tx, current, operation, now));
				}
				if (query.id) {
					const first = data[0];
					if (!first) throw new HttpError("NOT_FOUND");
					return {
						data:
							operation.principal.kind === "license" ? this.safe(first) : first,
					};
				}
				const last = rows.at(-1);
				return {
					data,
					nextCursor:
						chosen.length > query.limit && last ? query.cursor(last) : null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}
	async self(operation: $Operation) {
		this.auth.require(operation.principal, "self");
		return this.database.transaction(
			async (tx) => {
				const [row] = await this.lock(tx, [operation.principal.id]);
				await this.auth.assertLicense(tx, operation.principal);
				if (!row) throw new HttpError("NOT_FOUND");
				return {
					data: this.safe(
						await this.view(tx, row, operation, await this.now(tx)),
					),
				};
			},
			"read",
			operation.deadlineAt,
		);
	}
	async update(input: $LicenseUpdate, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:update");
		this.checkInput(input.changes);
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"license.update",
			input,
			async (tx) => {
				const locked = await this.lock(tx, ids);
				const now = await this.now(tx);
				await this.relations(tx, input.changes);
				for (const row of locked) {
					const { meters: definitions, expiresAt, ...changes } = input.changes;
					const before = this.fields(row);
					const candidate = {
						...before,
						...changes,
						...(expiresAt !== undefined ? { expiresAt } : {}),
					};
					const diff = this.audit.changes(before, candidate);
					if (diff.changed) {
						await tx
							.update(licenses)
							.set({
								...changes,
								...(expiresAt !== undefined
									? { expiresAt: expiresAt ? new Date(expiresAt) : null }
									: {}),
								updatedBy: operation.principal.id,
								updatedAt: now,
							})
							.where(eq(licenses.id, row.id));
						if (changes.deviceLimit !== undefined)
							await this.truncateHardware(
								tx,
								row.id,
								changes.deviceLimit,
								operation,
								input.reason,
							);
						if (changes.ipLimit !== undefined)
							await this.truncateIps(
								tx,
								row.id,
								changes.ipLimit,
								operation,
								input.reason,
							);
						await this.audit.record(tx, {
							...this.evidence(operation, row.id, input.reason),
							action: "license.updated",
							before: diff.before,
							after: diff.after,
						});
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
							this.evidence(operation, row.id, input.reason),
							now,
						);
				}
				return { data: { ids } };
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
		return this.idempotency.admin(
			operation,
			`license.${action}`,
			input,
			async (tx) => {
				const locked = await this.lock(tx, ids);
				const now = await this.now(tx);
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
						...this.evidence(operation, row.id, input.reason),
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
		);
	}
	async delete(input: $LicenseDelete, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:delete");
		if (input.confirm !== true || !input.reason)
			throw new HttpError("INVALID_REQUEST");
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"license.delete",
			input,
			async (tx) => {
				await this.deletion.remove(tx, ids, operation, input.reason);
				return { data: { ids } };
			},
		);
	}
	async rotate(input: $LicenseRotate, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:rotate");
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"license.rotate",
			input,
			async (tx) => {
				const locked = await this.lock(tx, ids);
				const now = await this.now(tx);
				const data = [];
				for (const row of locked) {
					const format = await this.format(tx, row.itemId);
					let credential = "";
					for (let attempt = 0; attempt < 5; attempt++) {
						credential = this.keys.license(format);
						const [existing] = await tx
							.select({ id: licenses.id })
							.from(licenses)
							.where(eq(licenses.keyHash, this.hashes.hash(credential)));
						if (!existing) break;
						credential = "";
					}
					if (!credential)
						throw new Error("Credential generation collision limit reached");
					await tx
						.update(licenses)
						.set({
							keyHash: this.hashes.hash(credential),
							keyFormat: format,
							updatedBy: operation.principal.id,
							updatedAt: now,
						})
						.where(eq(licenses.id, row.id));
					await this.audit.record(tx, {
						...this.evidence(operation, row.id, input.reason),
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
			{ secretIds: (result) => result.data.map((row) => row.id) },
		);
	}
	async adjust(input: $MeterAdjustment, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:update");
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"license.meter.adjust",
			input,
			async (tx) => {
				const locked = await this.lock(tx, ids);
				const now = await this.now(tx);
				for (const row of locked)
					await this.meters.adjust(
						tx,
						row.id,
						input.name,
						input.action,
						input.value,
						this.evidence(operation, row.id, input.reason),
						now,
					);
				return { data: { ids } };
			},
		);
	}
	async removeHardware(input: $HardwareRemoval, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:update");
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"license.hardware.remove",
			input,
			async (tx) => {
				for (const row of await this.lock(tx, ids)) {
					const removed = await tx
						.delete(hardware)
						.where(
							and(
								eq(hardware.licenseId, row.id),
								inArray(hardware.hardwareId, input.hardwareIds),
							),
						)
						.returning();
					if (removed.length)
						await this.audit.record(tx, {
							...this.evidence(operation, row.id, input.reason),
							action: "license.hardware.removed",
							before: { hardwareIds: removed.map((entry) => entry.hardwareId) },
						});
				}
				return { data: { ids } };
			},
		);
	}
	async removeIps(input: $IpRemoval, operation: $Operation) {
		this.auth.require(operation.principal, "licenses:update");
		const ids = this.input.ids(input.ids);
		const addresses = await Promise.all(
			input.ips.map((ip) => this.ip.normalize(ip, operation.deadlineAt)),
		);
		return this.idempotency.admin(
			operation,
			"license.ips.remove",
			input,
			async (tx) => {
				for (const row of await this.lock(tx, ids)) {
					const removed = await tx
						.delete(ips)
						.where(and(eq(ips.licenseId, row.id), inArray(ips.ip, addresses)))
						.returning();
					if (removed.length)
						await this.audit.record(tx, {
							...this.evidence(operation, row.id, input.reason),
							action: "license.ips.removed",
							before: { ips: removed.map((entry) => entry.ip) },
						});
				}
				return { data: { ids } };
			},
		);
	}
	private async view(
		tx: $Transaction,
		row: $License,
		operation: $Operation,
		now: Date,
	) {
		const meters = await this.meters.effective(
			tx,
			row.id,
			this.evidence(operation, row.id),
			now,
		);
		const safe = {
			id: row.id,
			enabled: row.enabled,
			userId: row.userId,
			itemId: row.itemId,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			deviceLimit: row.deviceLimit,
			ipLimit: row.ipLimit,
			allowedIps: row.allowedIps,
			metadata: row.metadata,
			meters: meters.map((meter) => this.meters.view(meter)),
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
		const hardwareIds = await tx
			.select()
			.from(hardware)
			.where(eq(hardware.licenseId, row.id))
			.orderBy(asc(hardware.registrationOrder));
		const registeredIps = await tx
			.select()
			.from(ips)
			.where(eq(ips.licenseId, row.id))
			.orderBy(asc(ips.registrationOrder));
		return {
			...safe,
			disabledReason: row.disabledReason,
			notes: row.notes,
			keyFormat: row.keyFormat,
			createdBy: row.createdBy,
			updatedBy: row.updatedBy,
			hardwareIds: hardwareIds.map((entry) => entry.hardwareId),
			registeredIps: registeredIps.map((entry) => entry.ip),
		};
	}
	private safe(row: $LicenseAdmin) {
		return {
			id: row.id,
			enabled: row.enabled,
			userId: row.userId,
			itemId: row.itemId,
			expiresAt: row.expiresAt,
			deviceLimit: row.deviceLimit,
			ipLimit: row.ipLimit,
			allowedIps: row.allowedIps,
			metadata: row.metadata,
			meters: row.meters,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}
	private fields(row: $License) {
		return {
			userId: row.userId,
			itemId: row.itemId,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			deviceLimit: row.deviceLimit,
			ipLimit: row.ipLimit,
			allowedIps: row.allowedIps,
			metadata: row.metadata,
			notes: row.notes,
		};
	}
	private evidence(operation: $Operation, licenseId: string, reason?: string) {
		return {
			...operation,
			actor: operation.principal,
			action: "license.updated",
			targetType: "license",
			targetId: licenseId,
			reason,
		};
	}
	private checkInput(input: $LicenseCreate) {
		this.input.metadata(input.metadata);
		this.input.notes(input.notes);
		if (input.allowedIps) this.ip.validateRules(input.allowedIps);
	}
	private async lock(tx: $Transaction, ids: string[]) {
		const rows = await tx
			.select()
			.from(licenses)
			.where(inArray(licenses.id, ids))
			.orderBy(asc(licenses.id))
			.for("update");
		if (rows.length !== ids.length)
			throw new HttpError("BULK_OPERATION_FAILED");
		return rows;
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
			input.itemId &&
			!(
				await tx
					.select({ id: items.id })
					.from(items)
					.where(eq(items.id, input.itemId))
			).length
		)
			throw new HttpError("NOT_FOUND");
	}
	private async format(tx: $Transaction, itemId?: string | null) {
		const settings = await this.settings.read(tx);
		if (!settings.globalFormatEnabled && itemId) {
			const [item] = await tx
				.select({ keyFormat: items.keyFormat })
				.from(items)
				.where(eq(items.id, itemId));
			if (item?.keyFormat) return item.keyFormat;
		}
		return settings.globalKeyFormat;
	}
	private async truncateHardware(
		tx: $Transaction,
		licenseId: string,
		limit: number | null,
		operation: $Operation,
		reason?: string,
	) {
		const removed = await tx
			.select({ id: hardware.id, hardwareId: hardware.hardwareId })
			.from(hardware)
			.where(eq(hardware.licenseId, licenseId))
			.orderBy(asc(hardware.registrationOrder))
			.offset(limit ?? 0);
		if (removed.length)
			await tx.delete(hardware).where(
				inArray(
					hardware.id,
					removed.map((row) => row.id),
				),
			);
		if (removed.length)
			await this.audit.record(tx, {
				...this.evidence(operation, licenseId, reason),
				action: "license.hardware.removed",
				before: { hardwareIds: removed.map((row) => row.hardwareId) },
			});
	}
	private async truncateIps(
		tx: $Transaction,
		licenseId: string,
		limit: number | null,
		operation: $Operation,
		reason?: string,
	) {
		const removed = await tx
			.select({ id: ips.id, ip: ips.ip })
			.from(ips)
			.where(eq(ips.licenseId, licenseId))
			.orderBy(asc(ips.registrationOrder))
			.offset(limit ?? 0);
		if (removed.length)
			await tx.delete(ips).where(
				inArray(
					ips.id,
					removed.map((row) => row.id),
				),
			);
		if (removed.length)
			await this.audit.record(tx, {
				...this.evidence(operation, licenseId, reason),
				action: "license.ips.removed",
				before: { ips: removed.map((row) => row.ip) },
			});
	}
	private async now(tx: $Transaction) {
		const [row] = await tx
			.select({ now: sql<Date>`clock_timestamp()` })
			.from(sql`(values (1)) as clock`);
		if (!row) throw new Error("Database time unavailable");
		return row.now;
	}
}
