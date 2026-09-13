import type { Database, Transaction } from "../database/Database.ts";
import type {
	LicenseRepository,
	LicenseDetails,
} from "../licenses/LicenseRepository.ts";
import type { LicensePolicy } from "../licenses/LicensePolicy.ts";
import type { AccessRepository } from "../access/AccessRepository.ts";
import type { ActivityRepository } from "../activity/ActivityRepository.ts";
import type { SessionRepository } from "./SessionRepository.ts";
import type { SessionRecord, activationBody, sessionQuery } from "./schemas.ts";
import type { AppLogger } from "../shared/logging.ts";
import { digest, secret } from "../shared/security.ts";
import { normalizeIp } from "../shared/ClientIp.ts";
import { AppError, required } from "../shared/errors.ts";
import type { SessionWorkQueue } from "./SessionWorkQueue.ts";
import { collection, pagination } from "../shared/schemas.ts";

export type SessionIdentity = { token: string; deviceId: string; ip: string };

export class SessionService {
	constructor(
		private readonly database: Database,
		private readonly repository: SessionRepository,
		private readonly licenses: LicenseRepository,
		private readonly policy: LicensePolicy,
		private readonly access: AccessRepository,
		private readonly activity: ActivityRepository,
		private readonly ttl: number,
		private readonly logger: AppLogger,
		private readonly work: SessionWorkQueue,
	) {}
	async activate(input: typeof activationBody.infer, ip: string) {
		return this.work.run(`key:${digest(input.key)}`, () =>
			this.activateQueued(input, ip),
		);
	}
	private async activateQueued(input: typeof activationBody.infer, ip: string) {
		const token = secret("ses");
		const id = digest(token);
		let reservation: SessionRecord | undefined;
		try {
			return await this.database.orm.transaction(async (tx) => {
				const row = await this.licenses.lockByKey(tx, digest(input.key));
				if (!row)
					throw new AppError("LICENSE_INVALID", "License key is invalid.", 401);
				const license = required(await this.licenses.get(row.id, tx));
				this.policy.assertActive(license);
				const deviceHash = digest(input.deviceId);
				const address = normalizeIp(ip);
				await this.access.admit(tx, row, deviceHash, address);
				if (
					license.type === "trial" &&
					license.trial &&
					!license.trial.activatedAt
				)
					await this.licenses.activateTrial(
						tx,
						row.id,
						license.trial.durationSeconds,
					);
				reservation = {
					licenseId: row.id,
					deviceHash,
					ip: address,
					revision: row.policyRevision,
				};
				await this.repository.admit(id, reservation, this.ttl, row.maxSessions);
				await this.activity.write(tx, "session.activated", row.id);
				return {
					token,
					licenseId: row.id,
					type: row.type,
					metadata: row.metadata,
					expiresIn: this.ttl,
				};
			});
		} catch (error) {
			if (reservation) {
				try {
					await this.repository.remove(id, reservation);
				} catch {
					this.logger.error("session.compensation_failed_ttl_cleanup_pending");
				}
			}
			throw error;
		}
	}
	async withSession<T>(
		identity: SessionIdentity,
		operation: (
			tx: Transaction,
			license: LicenseDetails,
			session: { id: string; record: SessionRecord; raw: string },
		) => Promise<T>,
	) {
		const id = digest(identity.token);
		const { record, raw } = await this.repository.get(id);
		if (
			record.deviceHash !== digest(identity.deviceId) ||
			record.ip !== normalizeIp(identity.ip)
		)
			throw new AppError(
				"SESSION_BINDING",
				"Session does not match this device and IP.",
				401,
			);
		return this.work.run(`license:${record.licenseId}`, () =>
			this.database.orm.transaction(async (tx) => {
				await this.licenses.lock(tx, record.licenseId);
				const license = required(await this.licenses.get(record.licenseId, tx));
				if (record.revision !== license.policyRevision)
					throw new AppError(
						"SESSION_STALE",
						"License policy changed. Activate a new session.",
						401,
					);
				this.policy.assertActive(license);
				// Re-read after taking the database lock: termination or TTL expiry may
				// have occurred while this request waited for another operation.
				const current = await this.repository.get(id);
				if (current.raw !== raw)
					throw new AppError("SESSION_INVALID", "Session is invalid.", 401);
				return operation(tx, license, { id, record, raw });
			}),
		);
	}
	async heartbeat(identity: SessionIdentity) {
		return this.withSession(identity, async (tx, license, session) => {
			await this.repository.refresh(
				session.id,
				session.record,
				session.raw,
				this.ttl,
			);
			await this.activity.write(tx, "session.heartbeat", license.id);
			return { licenseId: license.id, type: license.type, expiresIn: this.ttl };
		});
	}
	async deactivate(identity: SessionIdentity) {
		return this.withSession(identity, async (tx, license, session) => {
			await this.repository.remove(session.id, session.record);
			await this.activity.write(tx, "session.deactivated", license.id);
			return { deactivated: true };
		});
	}
	async list(query: typeof sessionQuery.infer) {
		const page = pagination(query);
		const license = required(
			await this.licenses.get(query.licenseId),
			"License",
		);
		return collection(
			await this.repository.list(license.id, license.policyRevision, page),
			page,
		);
	}
	async terminateAll(id: string) {
		return this.database.orm.transaction(async (tx) => {
			await this.licenses.lock(tx, id);
			await this.licenses.update(tx, id, {});
			await this.activity.write(tx, "session.terminated_all", id);
			return { terminated: true };
		});
	}
	async terminate(id: string, sessionId: string) {
		return this.database.orm.transaction(async (tx) => {
			await this.licenses.lock(tx, id);
			const session = await this.repository.get(sessionId);
			if (session.record.licenseId !== id)
				throw new AppError("NOT_FOUND", "Session not found.", 404);
			await this.repository.remove(sessionId, session.record);
			await this.activity.write(tx, "session.terminated", id);
			return { terminated: true };
		});
	}
}
