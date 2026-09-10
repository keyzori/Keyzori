export const admitSession = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 0 end
if not redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return -1 end
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), ARGV[4])
local latest = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
redis.call('PEXPIREAT', KEYS[2], latest[2])
return 1
`;

export const refreshSession = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), ARGV[3])
local latest = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
redis.call('PEXPIREAT', KEYS[2], latest[2])
return 1
`;

export const removeSession = `
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

export const listSessions = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
return redis.call('ZRANGE', KEYS[1], ARGV[1], ARGV[2])
`;
