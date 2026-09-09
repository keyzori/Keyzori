import type { RedisClient } from "bun";
import type { Elysia } from "elysia";
import {
	ClientIpResolver,
	type ClientIpOptions,
} from "../controllers/clientIp";

const WINDOW_MS = 60_000;
const WINDOW_EXPIRY_SECONDS = 60;

const RATE_LIMIT_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], 0, ARGV[1])
local count = redis.call("ZCARD", KEYS[1])
if count >= tonumber(ARGV[4]) then
  local oldest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
  local retryAfter = 1
  if oldest[2] then
    retryAfter = math.max(1, math.ceil((tonumber(oldest[2]) + 60000 - tonumber(ARGV[2])) / 1000))
  end
  redis.call("EXPIRE", KEYS[1], ARGV[5])
  return {0, retryAfter}
end
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])
redis.call("EXPIRE", KEYS[1], ARGV[5])
return {1, 0}
`;

export interface RateLimitResult {
	allowed: boolean;
	retryAfterSeconds: number;
}

export class RedisSlidingWindowRateLimiter {
	constructor(private readonly redis: RedisClient) {}

	public async consume(key: string, limit: number): Promise<RateLimitResult> {
		const now = Date.now();
		const result: unknown = await this.redis.send("EVAL", [
			RATE_LIMIT_SCRIPT,
			"1",
			key,
			String(now - WINDOW_MS),
			String(now),
			`${now}:${crypto.randomUUID()}`,
			String(limit),
			String(WINDOW_EXPIRY_SECONDS),
		]);
		if (
			!Array.isArray(result) ||
			result.length !== 2 ||
			(result[0] !== 0 && result[0] !== 1) ||
			typeof result[1] !== "number"
		) {
			throw new Error("Redis returned an invalid rate limit result.");
		}
		return {
			allowed: result[0] === 1,
			retryAfterSeconds: Math.max(0, Math.ceil(result[1])),
		};
	}
}

export async function enforceRateLimit(
	limiter: RedisSlidingWindowRateLimiter,
	key: string,
	limit: number,
	set: {
		status?: number | string;
		headers: Record<string, string | number>;
	},
): Promise<{ error: string; code: "RATE_LIMITED" } | undefined> {
	const result = await limiter.consume(key, limit);
	if (result.allowed) return;
	set.status = 429;
	set.headers["retry-after"] = String(result.retryAfterSeconds);
	return { error: "Too Many Requests", code: "RATE_LIMITED" };
}

/** Coarse per-IP abuse ceiling shared by all non-health application routes. */
export const rateLimiter =
	(
		limiter: RedisSlidingWindowRateLimiter,
		requestsPerMinute: number,
		clientIpResolver: ClientIpResolver,
	) =>
	(app: Elysia) =>
		app.onBeforeHandle(async ({ request, server, set }) => {
			if (new URL(request.url).pathname === "/ready") return;
			const ip = clientIpResolver.resolve(request, server);
			return await enforceRateLimit(
				limiter,
				`ratelimit:ip:${ip}`,
				requestsPerMinute,
				set,
			);
		});

export function createRateLimitDependencies(
	redis: RedisClient,
	options: ClientIpOptions,
): {
	limiter: RedisSlidingWindowRateLimiter;
	clientIpResolver: ClientIpResolver;
} {
	return {
		limiter: new RedisSlidingWindowRateLimiter(redis),
		clientIpResolver: new ClientIpResolver(options),
	};
}
