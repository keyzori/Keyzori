import type { PgColumn } from "drizzle-orm/pg-core";

export type $ResourceSort = "createdAt" | "updatedAt" | "expiresAt";

export type $QueryColumns = {
	id: PgColumn;
	createdAt: PgColumn;
	updatedAt: PgColumn;
	name?: PgColumn;
	notes?: PgColumn;
	enabled?: PgColumn;
	metadata?: PgColumn;
	userId?: PgColumn;
	itemId?: PgColumn;
	expiresAt?: PgColumn;
	deviceLimit?: PgColumn;
};
