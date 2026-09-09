import type { RedisClient } from "bun";
import type {
	ISessionRepository,
	ResolvedSession,
	SessionBinding,
	SessionRegistrationResult,
} from "../../domain/repositories/ISessionRepository";

const REGISTER_SESSION_SCRIPT = `
local members = redis.call("SMEMBERS", KEYS[1])
for _, member in ipairs(members) do
  local memberKey = ARGV[4] .. member
  local value = redis.call("GET", memberKey)
  local firstSeparator = value and string.find(value, "|", 1, true)
  local secondSeparator = firstSeparator and string.find(value, "|", firstSeparator + 1, true)
  local revision = secondSeparator and string.sub(value, firstSeparator + 1, secondSeparator - 1)
  if not value or revision ~= ARGV[6] then
    redis.call("DEL", memberKey)
    redis.call("SREM", KEYS[1], member)
  end
end

local maximum = tonumber(ARGV[3])
if maximum > 0 and redis.call("SCARD", KEYS[1]) >= maximum then
  return -1
end

redis.call("SET", KEYS[2], ARGV[5], "EX", ARGV[2])
redis.call("SADD", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[2])
return 1
`;

const REFRESH_SESSION_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if not value then
  return ""
end
local firstSeparator = string.find(value, "|", 1, true)
local secondSeparator = firstSeparator and string.find(value, "|", firstSeparator + 1, true)
if not firstSeparator or not secondSeparator or string.sub(value, secondSeparator + 1) ~= ARGV[1] then
  return ""
end
local licenseId = string.sub(value, 1, firstSeparator - 1)
local revision = string.sub(value, firstSeparator + 1, secondSeparator - 1)
redis.call("EXPIRE", KEYS[1], ARGV[2])
redis.call("SADD", ARGV[3] .. licenseId, ARGV[4])
redis.call("EXPIRE", ARGV[3] .. licenseId, ARGV[2])
return licenseId .. "|" .. revision
`;

const REMOVE_SESSION_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if not value then
  return ""
end
local firstSeparator = string.find(value, "|", 1, true)
local secondSeparator = firstSeparator and string.find(value, "|", firstSeparator + 1, true)
if not firstSeparator or not secondSeparator or string.sub(value, secondSeparator + 1) ~= ARGV[1] then
  return ""
end
local licenseId = string.sub(value, 1, firstSeparator - 1)
local revision = string.sub(value, firstSeparator + 1, secondSeparator - 1)
redis.call("SREM", ARGV[2] .. licenseId, ARGV[3])
if redis.call("SCARD", ARGV[2] .. licenseId) == 0 then
  redis.call("DEL", ARGV[2] .. licenseId)
end
redis.call("DEL", KEYS[1])
return licenseId .. "|" .. revision
`;

const REMOVE_ALL_SESSIONS_SCRIPT = `
local members = redis.call("SMEMBERS", KEYS[1])
local removed = 0
local minimumRevision = ARGV[2] ~= "" and tonumber(ARGV[2]) or nil
for _, member in ipairs(members) do
  local memberKey = ARGV[1] .. member
  local value = redis.call("GET", memberKey)
  local shouldRemove = not minimumRevision
  if minimumRevision and value then
    local firstSeparator = string.find(value, "|", 1, true)
    local secondSeparator = firstSeparator and string.find(value, "|", firstSeparator + 1, true)
    local revision = secondSeparator and tonumber(string.sub(value, firstSeparator + 1, secondSeparator - 1))
    shouldRemove = not revision or revision < minimumRevision
  elseif not value then
    redis.call("SREM", KEYS[1], member)
  end
  if shouldRemove and redis.call("DEL", memberKey) == 1 then
    removed = removed + 1
    redis.call("SREM", KEYS[1], member)
  end
end
if redis.call("SCARD", KEYS[1]) == 0 then
  redis.call("DEL", KEYS[1])
end
return removed
`;

const SESSION_PREFIX = "license_session:";
const SESSION_SET_PREFIX = "license_sessions:";

export class RedisSessionRepository implements ISessionRepository {
	constructor(private readonly redis: RedisClient) {}

	async registerSession(
		licenseId: string,
		sessionRevision: number,
		binding: SessionBinding,
		ttlSeconds: number,
		maxSessions: number,
	): Promise<SessionRegistrationResult> {
		const sessionToken = crypto.randomUUID();
		const result: unknown = await this.redis.send("EVAL", [
			REGISTER_SESSION_SCRIPT,
			"2",
			`${SESSION_SET_PREFIX}${licenseId}`,
			`${SESSION_PREFIX}${sessionToken}`,
			sessionToken,
			String(ttlSeconds),
			String(maxSessions),
			SESSION_PREFIX,
			`${licenseId}|${sessionRevision}|${this.hashBinding(binding)}`,
			String(sessionRevision),
		]);
		if (result === 1) return { status: "registered", token: sessionToken };
		if (result === -1) return { status: "limit-reached" };
		throw new Error("Redis returned an invalid session registration result.");
	}

	async refreshSession(
		sessionToken: string,
		binding: SessionBinding,
		ttlSeconds: number,
	): Promise<ResolvedSession | null> {
		const result: unknown = await this.redis.send("EVAL", [
			REFRESH_SESSION_SCRIPT,
			"1",
			`${SESSION_PREFIX}${sessionToken}`,
			this.hashBinding(binding),
			String(ttlSeconds),
			SESSION_SET_PREFIX,
			sessionToken,
		]);
		if (typeof result === "string" && result.length > 0)
			return this.resolvedSession(result, sessionToken);
		if (result === "" || result === null || result === 0) return null;
		throw new Error("Redis returned an invalid session refresh result.");
	}

	async removeSession(
		sessionToken: string,
		binding: SessionBinding,
	): Promise<ResolvedSession | null> {
		const result: unknown = await this.redis.send("EVAL", [
			REMOVE_SESSION_SCRIPT,
			"1",
			`${SESSION_PREFIX}${sessionToken}`,
			this.hashBinding(binding),
			SESSION_SET_PREFIX,
			sessionToken,
		]);
		if (typeof result === "string" && result.length > 0)
			return this.resolvedSession(result, sessionToken);
		if (result === "" || result === null || result === 0) return null;
		throw new Error("Redis returned an invalid session removal result.");
	}

	async removeAllSessions(
		licenseId: string,
		preserveFromRevision?: number,
	): Promise<number> {
		const result: unknown = await this.redis.send("EVAL", [
			REMOVE_ALL_SESSIONS_SCRIPT,
			"1",
			`${SESSION_SET_PREFIX}${licenseId}`,
			SESSION_PREFIX,
			preserveFromRevision === undefined ? "" : String(preserveFromRevision),
		]);
		if (typeof result === "number" && Number.isInteger(result)) return result;
		throw new Error("Redis returned an invalid session termination result.");
	}

	private hashBinding(binding: SessionBinding): string {
		return new Bun.CryptoHasher("sha256")
			.update(`${binding.ip}\0${binding.deviceId}`)
			.digest("hex");
	}

	private resolvedSession(value: string, token: string): ResolvedSession {
		const separator = value.lastIndexOf("|");
		const licenseId = value.slice(0, separator);
		const sessionRevision = Number(value.slice(separator + 1));
		if (
			separator < 1 ||
			!Number.isSafeInteger(sessionRevision) ||
			sessionRevision < 0
		) {
			throw new Error("Redis returned an invalid resolved session.");
		}
		return { licenseId, sessionRevision, token };
	}
}
