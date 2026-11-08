import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { apiKeys } from "./apiKeys";

export const apiKeyGroups = pgTable(
	"api_key_groups",
	{
		apiKeyId: uuid("api_key_id")
			.notNull()
			.references(() => apiKeys.id, { onDelete: "cascade" }),
		/** Stable grants retain authority to a deleted group's audit/event history. */
		groupId: uuid("group_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.apiKeyId, table.groupId] }),
		index("api_key_groups_group_idx").on(table.groupId),
	],
);
