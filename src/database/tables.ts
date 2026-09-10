import { sql } from "drizzle-orm";
import { check, integer, pgTable } from "drizzle-orm/pg-core";

export const applicationIdentity = pgTable(
	"keyzori_application",
	{ version: integer().primaryKey().default(2) },
	(t) => [check("application_version", sql`${t.version} = 2`)],
);
