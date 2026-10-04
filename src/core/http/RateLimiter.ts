import type { Redis } from "../redis/Redis";
import { SecretHasher } from "../security/SecretHasher";
import { HttpError } from "./HttpError";

export class RateLimiter {
	private readonly hasher = new SecretHasher();
	private readonly script = `
		local count = redis.call('INCR', KEYS[1])
		if count == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end
		local ttl = redis.call('PTTL', KEYS[1])
		if ttl < 0 then
			redis.call('PEXPIRE', KEYS[1], 60000)
			ttl = 60000
		end
		return {count, ttl}
	`;

	constructor(private readonly redis: Redis) {}

	async check(bucket: string, limit: number, deadlineAt?: number) {
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw new Error("Rate limit must be a positive integer");
		let result: unknown;
		try {
			result = await this.redis.send(
				"EVAL",
				[this.script, "1", `kz:rate:${this.hasher.hash(bucket)}`],
				deadlineAt,
			);
		} catch {
			throw new HttpError("SERVICE_UNAVAILABLE");
		}
		if (!Array.isArray(result) || result.length !== 2)
			throw new HttpError("SERVICE_UNAVAILABLE");
		const [count, ttl] = result;
		if (
			typeof count !== "number" ||
			!Number.isSafeInteger(count) ||
			count < 1 ||
			typeof ttl !== "number" ||
			!Number.isSafeInteger(ttl) ||
			ttl < 0 ||
			ttl > 60000
		) {
			throw new HttpError("SERVICE_UNAVAILABLE");
		}
		if (count > limit)
			throw new HttpError(
				"RATE_LIMITED",
				undefined,
				undefined,
				Math.max(1, Math.ceil(ttl / 1000)),
			);
	}
}
