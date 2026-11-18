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
		stagedSecretCiphertext: text("staged_secret_ciphertext"),
		stagedSigningKeyId: uuid("staged_signing_key_id"),
		version: integer().notNull().default(1),
		lastSequence: bigint("last_sequence", { mode: "bigint" })
			.notNull()
			.default(0n),
		enabled: boolean().notNull().default(false),
		lastError: text("last_error"),
		dispatchFailures: integer("dispatch_failures").notNull().default(0),
		dispatchRetryAt: timestamp("dispatch_retry_at", {
			withTimezone: true,
			precision: 3,
		}),
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
			"webhooks_staged_key_check",
			sql`(${table.stagedSigningKeyId} is null) = (${table.stagedSecretCiphertext} is null) and ${table.stagedSigningKeyId} is distinct from ${table.signingKeyId}`,
		),
		check(
			"webhooks_dispatch_retry_check",
			sql`${table.dispatchFailures} between 0 and 6 and ((${table.dispatchFailures} = 0) = (${table.dispatchRetryAt} is null))`,
		),
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
