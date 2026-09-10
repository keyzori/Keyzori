import type { RedisClient } from "bun";
import { AppError } from "../shared/errors.ts";
import type { Page } from "../shared/schemas.ts";
import {
	admitSession,
	refreshSession,
	removeSession,
	listSessions,
} from "./scripts.ts";
import { sessionRecord, type SessionRecord } from "./schemas.ts";

export class SessionRepository {
	constructor(
		readonly redis: RedisClient,
		private readonly prefix = "keyzori:v2:",
	) {}
	key(id: string) {
		return `${this.prefix}session:${id}`;
	}
	index(record: Pick<SessionRecord, "licenseId" | "revision">) {
		return `${this.prefix}sessions:${record.licenseId}:${record.revision}`;
	}
	async get(id: string) {
		const raw = await this.redis.get(this.key(id));
		if (!raw)
			throw new AppError(
				"SESSION_INVALID",
				"Session is missing or expired.",
				401,
			);
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new AppError("SESSION_INVALID", "Session is invalid.", 401);
		}
		if (!sessionRecord.allows(value))
			throw new AppError("SESSION_INVALID", "Session is invalid.", 401);
		return { record: value, raw };
	}
	async admit(id: string, record: SessionRecord, ttl: number, limit: number) {
		const result = await this.redis.send("EVAL", [
			admitSession,
			"2",
			this.key(id),
			this.index(record),
			JSON.stringify(record),
			String(ttl * 1000),
			String(limit),
			id,
		]);
		if (Number(result) !== 1)
			throw new AppError(
				"SESSION_LIMIT",
				"Concurrent session limit reached.",
				409,
			);
	}
	async refresh(id: string, record: SessionRecord, raw: string, ttl: number) {
		const result = await this.redis.send("EVAL", [
			refreshSession,
			"2",
			this.key(id),
			this.index(record),
			raw,
			String(ttl * 1000),
			id,
		]);
		if (Number(result) !== 1)
			throw new AppError(
				"SESSION_INVALID",
				"Session is missing or expired.",
				401,
			);
	}
	async remove(id: string, record: SessionRecord) {
		await this.redis.send("EVAL", [
			removeSession,
			"2",
			this.key(id),
			this.index(record),
			id,
		]);
	}
	async list(licenseId: string, revision: number, page: Page) {
		const ids = (await this.redis.send("EVAL", [
			listSessions,
			"1",
			this.index({ licenseId, revision }),
			String(page.offset),
			String(page.offset + page.limit),
		])) as string[];
		const result = [];
		for (const id of ids) {
			const raw = await this.redis.get(this.key(id));
			if (!raw) continue;
			const record: unknown = JSON.parse(raw);
			if (sessionRecord.allows(record))
				result.push({
					id,
					licenseId: record.licenseId,
					revision: record.revision,
					ttl: Number(await this.redis.send("TTL", [this.key(id)])),
				});
		}
		return result;
	}
}
