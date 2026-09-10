import type { Database, Executor } from "../database/Database.ts";
import type {
	LicenseRepository,
	LicenseDetails,
} from "../licenses/LicenseRepository.ts";
import type { ActivityRepository } from "../activity/ActivityRepository.ts";
import type { MeterRepository } from "./MeterRepository.ts";
import type { meterBody, usageBody, usageQuery } from "./schemas.ts";
import { collection, pagination } from "../shared/schemas.ts";
import { AppError, required } from "../shared/errors.ts";

export class MeterService {
	constructor(
		private readonly database: Database,
		private readonly repository: MeterRepository,
		private readonly licenses: LicenseRepository,
		private readonly activity: ActivityRepository,
	) {}
	async get(id: string) {
		return required(await this.repository.get(id), "Meter");
	}
	async create(input: typeof meterBody.infer) {
		return this.database.orm.transaction(async (tx) => {
			const license = await this.licenses.lock(tx, input.licenseId);
			if (license.type !== "metered")
				throw new AppError("INVALID_TYPE", "Meters require a metered license.");
			const meter = await this.repository.create(tx, input);
			await this.activity.write(tx, "meter.created", input.licenseId);
			return meter;
		});
	}
	async update(id: string, limit: number) {
		const existing = required(await this.repository.get(id), "Meter");
		return this.database.orm.transaction(async (tx) => {
			const license = await this.licenses.lock(tx, existing.licenseId);
			if (license.type !== "metered")
				throw new AppError("INVALID_TYPE", "Meters require a metered license.");
			const meter = required(await this.repository.get(id, tx));
			if (limit < meter.used)
				throw new AppError(
					"INVALID_LIMIT",
					"Limit cannot be below consumed usage.",
				);
			const result = await this.repository.setLimit(tx, id, limit);
			await this.activity.write(tx, "meter.updated", meter.licenseId);
			return result;
		});
	}
	async list(query: typeof usageQuery.infer) {
		required(await this.licenses.get(query.licenseId), "License");
		const page = pagination(query);
		return collection(await this.repository.list(query.licenseId, page), page);
	}
	async usage(query: typeof usageQuery.infer) {
		required(await this.licenses.get(query.licenseId), "License");
		const page = pagination(query);
		return collection(
			await this.repository.usage(query.licenseId, page, query.meterId),
			page,
		);
	}
	// Caller holds the license lock for the entire bound-session transaction.
	async consume(
		tx: Executor,
		license: LicenseDetails,
		input: typeof usageBody.infer,
	) {
		if (license.type !== "metered")
			throw new AppError("INVALID_TYPE", "Usage requires a metered license.");
		const meter = required(
			await this.repository.byName(tx, license.id, input.meter),
			"Meter",
		);
		const previous = await this.repository.event(tx, license.id, input.eventId);
		if (previous) {
			if (previous.meterId !== meter.id || previous.units !== input.units)
				throw new AppError(
					"EVENT_CONFLICT",
					"Event ID was already used for a different request.",
					409,
				);
			return previous;
		}
		if (!Number.isSafeInteger(input.units) || input.units <= 0)
			throw new AppError(
				"INVALID_UNITS",
				"Units must be a positive safe integer.",
			);
		if (input.units > meter.limit - meter.used)
			throw new AppError(
				"METER_EXHAUSTED",
				"Meter has insufficient remaining units.",
				409,
			);
		const used = meter.used + input.units;
		const result = await this.repository.consume(tx, meter.id, used, {
			licenseId: license.id,
			meterId: meter.id,
			eventId: input.eventId,
			units: input.units,
			used,
			remaining: meter.limit - used,
		});
		await this.activity.write(tx, "usage.consumed", license.id);
		return result;
	}
}
