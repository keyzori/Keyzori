import { sql } from "drizzle-orm";
import { apiKeyGroups } from "../database/schema/apiKeyGroups";
import { apiKeys } from "../database/schema/apiKeys";

/** Correlated projection: key fields, generation and selected groups come from one snapshot. */
export const apiKeyGrantIds = sql<string[]>`coalesce((
	select jsonb_agg(${apiKeyGroups.groupId} order by ${apiKeyGroups.groupId})
	from ${apiKeyGroups} where ${apiKeyGroups.apiKeyId} = ${apiKeys.id}
), '[]'::jsonb)`.mapWith((value: unknown): string[] => {
	const ids: unknown = typeof value === "string" ? JSON.parse(value) : value;
	if (
		!Array.isArray(ids) ||
		ids.length > 100 ||
		!ids.every((id) => typeof id === "string")
	)
		throw new Error("Invalid stored API-key group grants");
	return ids;
});
