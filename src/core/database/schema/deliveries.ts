import { sql } from "drizzle-orm";
import {
	pgTable,
	uuid,
	text,
	jsonb,
	integer,
	timestamp,
	index,
	uniqueIndex,
	check,
	boolean,
} from "drizzle-orm/pg-core";
import type { $EventEnvelope } from "../../../types/webhooks";

export const deliveries = pgTable(
	"webhook_deliveries",
	{
		id: uuid().primaryKey(),
		webhookId: uuid("webhook_id").notNull(),
		eventId: uuid("event_id").notNull(),
		/** A deliberate replay has a new delivery identity and retains its source. */
		replayOf: uuid("replay_of"),
		groupId: uuid("group_id"),
		requiredGroupIds: uuid("required_group_ids").array().notNull().default([]),
		requiresAllGroups: boolean("requires_all_groups").notNull().default(false),
		global: boolean().notNull(),
		endpointVersion: integer("endpoint_version").notNull(),
		url: text().notNull(),
		secretCiphertext: text("secret_ciphertext").notNull(),
		signingKeyId: uuid("signing_key_id").notNull(),
		payload: jsonb().$type<$EventEnvelope>().notNull(),
		state: text({
			enum: ["pending", "claimed", "succeeded", "failed", "cancelled"],
		})
			.notNull()
			.default("pending"),
		attempts: integer().notNull().default(0),
		claimToken: uuid("claim_token"),
		leaseUntil: timestamp("lease_until", { withTimezone: true, precision: 3 }),
		nextAttemptAt: timestamp("next_attempt_at", {
			withTimezone: true,
			precision: 3,
		})
			.notNull()
			.defaultNow(),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			precision: 3,
		}).notNull(),
		attemptedAt: timestamp("attempted_at", {
			withTimezone: true,
			precision: 3,
		}),
		status: integer(),
		error: text(),
		createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("deliveries_event_idx")
			.on(table.webhookId, table.eventId)
			.where(sql`${table.replayOf} is null`),
		index("deliveries_claim_idx").on(table.state, table.nextAttemptAt),
		index("deliveries_expired_lease_idx")
			.on(table.leaseUntil)
			.where(sql`${table.state} = 'claimed'`),
		index("deliveries_retention_idx")
			.on(table.createdAt, table.id)
			.where(sql`${table.state} in ('succeeded','failed','cancelled')`),
		index("deliveries_webhook_idx").on(table.webhookId, table.createdAt),
		check(
			"deliveries_state_check",
			sql`${table.state} in ('pending','claimed','succeeded','failed','cancelled') and ${table.attempts} between 0 and 8`,
		),
		check(
			"deliveries_lease_check",
			sql`(${table.state} = 'claimed') = (${table.claimToken} is not null and ${table.leaseUntil} is not null) and ((${table.claimToken} is null) = (${table.leaseUntil} is null))`,
		),
	],
);

export const deliveryAttempts = pgTable(
	"webhook_delivery_attempts",
	{
		id: uuid().primaryKey(),
		deliveryId: uuid("delivery_id")
			.notNull()
			.references(() => deliveries.id, { onDelete: "cascade" }),
		attempt: integer().notNull(),
		startedAt: timestamp("started_at", {
			withTimezone: true,
			precision: 3,
		}).notNull(),
		/** Committed before transport starts. Null proves this claim never sent. */
		sendStartedAt: timestamp("send_started_at", {
			withTimezone: true,
			precision: 3,
		}),
		completedAt: timestamp("completed_at", {
			withTimezone: true,
			precision: 3,
		}),
		status: integer(),
		error: text(),
	},
	(table) => [
		index("delivery_attempts_delivery_idx").on(
			table.deliveryId,
			table.startedAt,
		),
		check(
			"delivery_attempt_number_check",
			sql`${table.attempt} between 1 and 8`,
		),
	],
);
