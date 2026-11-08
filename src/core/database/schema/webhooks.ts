import { sql } from "drizzle-orm";
import {
	pgTable,
	uuid,
	text,
	boolean,
	timestamp,
	integer,
	bigint,
	check,
} from "drizzle-orm/pg-core";
import { webhookEvents } from "../../../plugins/webhooks/events";

export const webhooks = pgTable(
	"webhooks",
	{
		id: uuid().primaryKey(),
		url: text().notNull(),
		events: text({ enum: webhookEvents }).array().notNull(),
		allGroups: boolean("all_groups").notNull().default(false),
		groupIds: uuid("group_ids").array().notNull().default([]),
		/** Null represents the environment operator; deleted API owners remain unavailable. */
		ownerApiKeyId: uuid("owner_api_key_id"),
		ownerCredentialHash: text("owner_credential_hash"),
		secretCiphertext: text("secret_ciphertext").notNull(),
		signingKeyId: uuid("signing_key_id").notNull(),
		version: integer().notNull().default(1),
		lastSequence: bigint("last_sequence", { mode: "bigint" })
			.notNull()
			.default(0n),
		enabled: boolean().notNull().default(false),
		lastError: text("last_error"),
		lastDispatchAt: timestamp("last_dispatch_at", {
			withTimezone: true,
			precision: 3,
		}),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"webhooks_owner_check",
			sql`(${table.ownerApiKeyId} is null) = (${table.ownerCredentialHash} is null)`,
		),
		check(
			"webhooks_groups_check",
			sql`cardinality(${table.groupIds}) <= 100 and (not ${table.allGroups} or cardinality(${table.groupIds}) = 0)`,
		),
		check(
			"webhooks_version_check",
			sql`${table.version} > 0 and ${table.lastSequence} >= 0`,
		),
	],
);
