import type { RedisClient } from "bun";
import { AppError } from "./errors.ts";
import { digest } from "./security.ts";

const increment = `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n`;
export class RateLimiter {
	constructor(
		private readonly redis: RedisClient,
		private readonly limit: number,
	) {}
	async check(ip: string, scope: string) {
		const count = Number(
			await this.redis.send("EVAL", [
				increment,
				"1",
				`keyzori:v2:rate:${scope}:${digest(ip)}`,
			]),
		);
		if (count > this.limit)
			throw new AppError(
				"RATE_LIMITED",
				"Request limit exceeded. Try again later.",
				429,
			);
	}
}
