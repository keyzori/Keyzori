import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type {
	License,
	NewLicense,
	NewLicenseMeter,
	RevealedLicense,
} from "../../domain/entities";
import type {
	ILicenseRepository,
	LicenseUpdate,
	LicenseUpdateOptions,
	LicenseWithAllowlists,
} from "../../domain/repositories/ILicenseRepository";
import { ConflictError, DomainError } from "../../domain/errors";
import type { Database } from "../../db";
import {
	licenseDeviceAllowlistEntries,
	licenseIpAllowlistEntries,
	licenseMeters,
	licenses,
	stripeSubscriptionLinks,
	usageLedgerEntries,
} from "../../db/schema";

function firstOrThrow<T>(rows: T[], action: string): T {
	const row = rows[0];
	if (!row) throw new Error(`Database returned no row after ${action}.`);
	return row;
}

type StoredLicense = typeof licenses.$inferSelect;

function nextLicenseUpdatedAt() {
	return sql`greatest(clock_timestamp()::timestamp, ${licenses.updatedAt} + interval '1 millisecond')`;
}

export function hashLicenseKey(licenseKey: string): string {
	return new Bun.CryptoHasher("sha256").update(licenseKey).digest("hex");
}

export function licenseKeyPrefix(licenseKey: string): string {
	return licenseKey.slice(0, 16);
}

function toDomainLicense(
	row: StoredLicense,
	billingRevokedAt: Date | null = null,
): License {
	const { keyHash: _keyHash, ...license } = row;
	return { ...license, billingRevokedAt };
}

export class DrizzleLicenseRepository implements ILicenseRepository {
	constructor(private readonly db: Database) {}

	async create(data: NewLicense): Promise<RevealedLicense> {
		const { licenseKey, meters, ...persistedData } = data;
		return await this.db.transaction(async (transaction) => {
			const rows = await transaction
				.insert(licenses)
				.values({
					id: crypto.randomUUID(),
					...persistedData,
					keyHash: hashLicenseKey(licenseKey),
					keyPrefix: licenseKeyPrefix(licenseKey),
				})
				.returning();
			const stored = firstOrThrow(rows, "creating a license");
			if (meters.length > 0) {
				const now = new Date();
				const storedMeters = meters.map((meter) => ({
					...meter,
					id: crypto.randomUUID(),
					licenseId: stored.id,
					createdAt: now,
					updatedAt: now,
				}));
				await transaction
					.insert(licenseMeters)
					.values(storedMeters.map(({ reason: _reason, ...meter }) => meter));
				await transaction.insert(usageLedgerEntries).values(
					storedMeters.map((meter) => ({
						id: crypto.randomUUID(),
						licenseId: stored.id,
						meterId: meter.id,
						eventId: `operator:${crypto.randomUUID()}`,
						kind: "create" as const,
						delta: meter.balance,
						balanceBefore: 0,
						balanceAfter: meter.balance,
						reason: meter.reason,
						createdAt: now,
					})),
				);
			}
			return {
				...toDomainLicense(stored),
				licenseKey,
			};
		});
	}

	async findById(id: string): Promise<License | null> {
		const rows = await this.db
			.select({
				license: licenses,
				billingRevokedAt: stripeSubscriptionLinks.billingRevokedAt,
			})
			.from(licenses)
			.leftJoin(
				stripeSubscriptionLinks,
				eq(stripeSubscriptionLinks.licenseId, licenses.id),
			)
			.where(eq(licenses.id, id))
			.limit(1);
		const row = rows[0];
		return row
			? toDomainLicense(row.license, row.billingRevokedAt ?? null)
			: null;
	}

	async findAll(): Promise<License[]> {
		const rows = await this.db
			.select({
				license: licenses,
				billingRevokedAt: stripeSubscriptionLinks.billingRevokedAt,
			})
			.from(licenses)
			.leftJoin(
				stripeSubscriptionLinks,
				eq(stripeSubscriptionLinks.licenseId, licenses.id),
			)
			.orderBy(desc(licenses.createdAt));
		return rows.map((row) =>
			toDomainLicense(row.license, row.billingRevokedAt ?? null),
		);
	}

	async findByIdWithAllowlists(
		id: string,
	): Promise<LicenseWithAllowlists | null> {
		const license = await this.findById(id);
		if (!license) return null;
		const [allowedIps, allowedDevices] = await Promise.all([
			this.db
				.select()
				.from(licenseIpAllowlistEntries)
				.where(eq(licenseIpAllowlistEntries.licenseId, id)),
			this.db
				.select()
				.from(licenseDeviceAllowlistEntries)
				.where(eq(licenseDeviceAllowlistEntries.licenseId, id)),
		]);
		return { ...license, allowedIps, allowedDevices };
	}

	async update(
		id: string,
		data: LicenseUpdate,
		options: LicenseUpdateOptions = {},
	): Promise<License> {
		const newMeters = options.newMeters ?? [];
		if (data.type !== undefined || newMeters.length > 0) {
			await this.db.transaction(async (transaction) => {
				let updateData = { ...data };
				if (data.type === "metered" || newMeters.length > 0) {
					await transaction.execute(
						sql`select pg_advisory_xact_lock(hashtextextended(${`meter:${id}`}, 0))`,
					);
				}
				const currentRows = await transaction
					.select({ id: licenses.id, updatedAt: licenses.updatedAt })
					.from(licenses)
					.where(eq(licenses.id, id))
					.limit(1)
					.for("update");
				const locked = firstOrThrow(
					currentRows,
					"locking a license for update",
				);
				if (
					options.expectedUpdatedAt &&
					locked.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()
				) {
					throw new ConflictError(
						"License changed concurrently; reload it and retry the update",
					);
				}

				await this.insertNewMeters(transaction, id, newMeters);

				if (data.type === "metered") {
					const activeMeters = await transaction
						.select({ id: licenseMeters.id })
						.from(licenseMeters)
						.where(
							and(
								eq(licenseMeters.licenseId, id),
								isNull(licenseMeters.archivedAt),
							),
						)
						.limit(1);
					if (!activeMeters[0]) {
						throw new DomainError(
							"Metered licenses require at least one active meter",
						);
					}
				}

				if (data.type !== "subscription") {
					const links = await transaction
						.select({ id: stripeSubscriptionLinks.id })
						.from(stripeSubscriptionLinks)
						.where(eq(stripeSubscriptionLinks.licenseId, id))
						.limit(1);
					if (links[0] && !options.confirmStripeUnlink) {
						throw new ConflictError(
							"Confirm unlinkStripe when changing a Stripe-linked subscription license",
						);
					}
					if (links[0]) {
						await transaction
							.delete(stripeSubscriptionLinks)
							.where(eq(stripeSubscriptionLinks.licenseId, id));
					}
				} else {
					const links = await transaction
						.select({ paidThrough: stripeSubscriptionLinks.paidThrough })
						.from(stripeSubscriptionLinks)
						.where(eq(stripeSubscriptionLinks.licenseId, id))
						.limit(1);
					const link = links[0];
					if (link) {
						if (options.manualExpiresAtUpdate) {
							throw new ConflictError(
								"Stripe-managed subscriptions cannot be renewed manually; sync or unlink Stripe first",
							);
						}
						const { expiresAt: _expiresAt, ...withoutExpiry } = updateData;
						updateData = withoutExpiry;
						if (updateData.typeDrafts && link.paidThrough) {
							updateData.typeDrafts = {
								...updateData.typeDrafts,
								subscription: {
									expiresAt: link.paidThrough.toISOString(),
								},
							};
						}
					}
				}

				const rows = await transaction
					.update(licenses)
					.set({ ...updateData, updatedAt: nextLicenseUpdatedAt() })
					.where(eq(licenses.id, id))
					.returning({ id: licenses.id });
				firstOrThrow(rows, "updating a license");
			});
		} else {
			const predicate = options.expectedUpdatedAt
				? and(
						eq(licenses.id, id),
						eq(licenses.updatedAt, options.expectedUpdatedAt),
					)
				: eq(licenses.id, id);
			const rows = await this.db
				.update(licenses)
				.set({ ...data, updatedAt: nextLicenseUpdatedAt() })
				.where(predicate)
				.returning({ id: licenses.id });
			if (!rows[0] && options.expectedUpdatedAt) {
				throw new ConflictError(
					"License changed concurrently; reload it and retry the update",
				);
			}
			firstOrThrow(rows, "updating a license");
		}
		const license = await this.findById(id);
		if (!license) throw new Error("Updated license could not be reloaded.");
		return license;
	}

	private async insertNewMeters(
		transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
		licenseId: string,
		meters: NewLicenseMeter[],
	): Promise<void> {
		if (meters.length === 0) return;
		const existing = await transaction
			.select()
			.from(licenseMeters)
			.where(eq(licenseMeters.licenseId, licenseId));
		const existingByName = new Map(
			existing.map((meter) => [meter.name, meter]),
		);
		const now = new Date();
		for (const meter of meters) {
			const stored = existingByName.get(meter.name);
			if (stored) {
				if (stored.archivedAt || stored.balance !== meter.balance) {
					throw new ConflictError(`Meter ${meter.name} already exists`);
				}
				continue;
			}
			const id = crypto.randomUUID();
			await transaction.insert(licenseMeters).values({
				id,
				licenseId,
				name: meter.name,
				balance: meter.balance,
				createdAt: now,
				updatedAt: now,
			});
			await transaction.insert(usageLedgerEntries).values({
				id: crypto.randomUUID(),
				licenseId,
				meterId: id,
				eventId: `operator:${crypto.randomUUID()}`,
				kind: "create",
				delta: meter.balance,
				balanceBefore: 0,
				balanceAfter: meter.balance,
				reason: meter.reason,
				createdAt: now,
			});
			existingByName.set(meter.name, {
				id,
				licenseId,
				name: meter.name,
				balance: meter.balance,
				archivedAt: null,
				createdAt: now,
				updatedAt: now,
			});
		}
	}

	async delete(id: string): Promise<void> {
		await this.db.delete(licenses).where(eq(licenses.id, id));
	}

	async findByLicenseKeyWithAllowlists(
		licenseKey: string,
	): Promise<LicenseWithAllowlists | null> {
		const rows = await this.db
			.select({
				license: licenses,
				billingRevokedAt: stripeSubscriptionLinks.billingRevokedAt,
			})
			.from(licenses)
			.leftJoin(
				stripeSubscriptionLinks,
				eq(stripeSubscriptionLinks.licenseId, licenses.id),
			)
			.where(eq(licenses.keyHash, hashLicenseKey(licenseKey)))
			.limit(1);
		const row = rows[0];
		if (!row) return null;
		const license = toDomainLicense(row.license, row.billingRevokedAt ?? null);
		const [allowedIps, allowedDevices] = await Promise.all([
			this.db
				.select()
				.from(licenseIpAllowlistEntries)
				.where(eq(licenseIpAllowlistEntries.licenseId, license.id)),
			this.db
				.select()
				.from(licenseDeviceAllowlistEntries)
				.where(eq(licenseDeviceAllowlistEntries.licenseId, license.id)),
		]);
		return { ...license, allowedIps, allowedDevices };
	}

	async rotateKey(
		id: string,
		licenseKey: string,
		expectedUpdatedAt?: Date,
	): Promise<RevealedLicense> {
		const predicate = expectedUpdatedAt
			? and(eq(licenses.id, id), eq(licenses.updatedAt, expectedUpdatedAt))
			: eq(licenses.id, id);
		return await this.db.transaction(async (transaction) => {
			const rows = await transaction
				.update(licenses)
				.set({
					keyHash: hashLicenseKey(licenseKey),
					keyPrefix: licenseKeyPrefix(licenseKey),
					sessionRevision: sql`${licenses.sessionRevision} + 1`,
					updatedAt: nextLicenseUpdatedAt(),
				})
				.where(predicate)
				.returning();
			if (!rows[0] && expectedUpdatedAt) {
				throw new ConflictError(
					"License changed concurrently; reload it and retry key rotation",
				);
			}
			const stored = firstOrThrow(rows, "rotating a license key");
			const billingRows = await transaction
				.select({ billingRevokedAt: stripeSubscriptionLinks.billingRevokedAt })
				.from(stripeSubscriptionLinks)
				.where(eq(stripeSubscriptionLinks.licenseId, id))
				.limit(1);
			return {
				...toDomainLicense(stored, billingRows[0]?.billingRevokedAt ?? null),
				licenseKey,
			};
		});
	}

	async incrementSessionRevision(id: string): Promise<License> {
		const rows = await this.db
			.update(licenses)
			.set({
				sessionRevision: sql`${licenses.sessionRevision} + 1`,
				updatedAt: nextLicenseUpdatedAt(),
			})
			.where(eq(licenses.id, id))
			.returning({ id: licenses.id });
		firstOrThrow(rows, "invalidating license sessions");
		const license = await this.findById(id);
		if (!license) throw new Error("Invalidated license could not be reloaded.");
		return license;
	}

	async updateWithSessionInvalidation(
		id: string,
		data: LicenseUpdate,
	): Promise<License> {
		const rows = await this.db
			.update(licenses)
			.set({
				...data,
				sessionRevision: sql`${licenses.sessionRevision} + 1`,
				updatedAt: nextLicenseUpdatedAt(),
			})
			.where(eq(licenses.id, id))
			.returning({ id: licenses.id });
		firstOrThrow(rows, "updating a license and invalidating sessions");
		const license = await this.findById(id);
		if (!license) throw new Error("Invalidated license could not be reloaded.");
		return license;
	}

	async updateMeterDraft(id: string, meterNames: string[]): Promise<License> {
		await this.db.transaction(async (transaction) => {
			const rows = await transaction
				.select({ typeDrafts: licenses.typeDrafts })
				.from(licenses)
				.where(eq(licenses.id, id))
				.limit(1)
				.for("update");
			const current = firstOrThrow(rows, "locking meter draft");
			await transaction
				.update(licenses)
				.set({
					typeDrafts: {
						...current.typeDrafts,
						metered: { meterNames: [...meterNames].sort() },
					},
					updatedAt: nextLicenseUpdatedAt(),
				})
				.where(eq(licenses.id, id));
		});
		const license = await this.findById(id);
		if (!license) throw new Error("Updated license could not be reloaded.");
		return license;
	}

	async startTrialIfUnset(id: string, startedAt: Date): Promise<License> {
		await this.db
			.update(licenses)
			.set({ trialStartedAt: startedAt, updatedAt: nextLicenseUpdatedAt() })
			.where(
				and(
					eq(licenses.id, id),
					eq(licenses.type, "trial"),
					isNull(licenses.trialStartedAt),
				),
			);
		const license = await this.findById(id);
		if (!license) throw new Error("Trial license could not be reloaded.");
		return license;
	}
}
