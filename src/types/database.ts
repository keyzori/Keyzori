import type { Database } from "../core/database/Database";

export type $Transaction = Parameters<
	Parameters<Database["orm"]["transaction"]>[0]
>[0];
