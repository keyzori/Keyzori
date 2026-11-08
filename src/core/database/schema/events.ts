import { sql } from "drizzle-orm";
import {
	pgTable,
	uuid,
	text,
	jsonb,
	timestamp,
	bigint,
	bigserial,
	integer,
	boolean,
	index,
	check,
	primaryKey,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import type { $EventEnvelope } from "../../../types/webhooks";

/** Sequence is assigned only after the producing transaction commits. */
export const activityEvents = pgTable(
	"activity_events",
	{
		id: uuid().primaryKey(),
		ordinal: bigserial({ mode: "bigint" }).notNull(),
		sequence: bigint({ mode: "bigint" }).unique(),
		groupId: uuid("group_id"),
		requiredGroupIds: uuid("required_group_ids").array().notNull().default([]),
		requiresAllGroups: boolean("requires_all_groups").notNull().default(false),
		global: boolean().notNull(),
		event: text().notNull(),
		payload: jsonb().$type<$EventEnvelope>().notNull(),
		resourceType: text("resource_type").notNull(),
		resourceId: text("resource_id").notNull(),
		resourceRevision: bigint("resource_revision", { mode: "bigint" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
			.notNull()
			.defaultNow(),
		publishedAt: timestamp("published_at", {
			withTimezone: true,
			precision: 3,
		}),
	},
	(table) => [
		index("events_unpublished_idx")
			.on(table.ordinal)
			.where(sql`${table.sequence} is null`),
		index("events_group_sequence_idx").on(table.groupId, table.sequence),
		index("events_retention_idx").on(table.sequence, table.publishedAt),
		uniqueIndex("events_resource_revision_idx").on(
			table.resourceType,
			table.resourceId,
			table.resourceRevision,
		),
		check(
			"events_publication_check",
			sql`(${table.sequence} is null) = (${table.publishedAt} is null) and (${table.sequence} is null or ${table.sequence} > 0) and ${table.resourceRevision} > 0`,
		),
	],
);
export const eventState = pgTable(
	"event_state",
	{
		id: integer().primaryKey(),
		epoch: uuid().notNull(),
		sequence: bigint({ mode: "bigint" }).notNull().default(0n),
		/** Cursors below this floor have lost an event and require a fresh snapshot. */
		retainedAfter: bigint("retained_after", { mode: "bigint" })
			.notNull()
			.default(0n),
	},
	(table) => [
		check(
			"event_state_singleton",
			sql`${table.id} = 1 and ${table.sequence} >= 0 and ${table.retainedAfter} >= 0 and ${table.retainedAfter} <= ${table.sequence}`,
		),
	],
);

/** Tombstones survive event retention and resource deletion; IDs never reuse revisions. */
export const eventResources = pgTable(
	"event_resources",
	{
		type: text().notNull(),
		id: text().notNull(),
		revision: bigint({ mode: "bigint" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.type, table.id] }),
		check("event_resources_revision_check", sql`${table.revision} > 0`),
	],
);
