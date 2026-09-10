import type { AnyElysia } from "elysia";
import type { Services } from "../application/Services.ts";
import type { Environment } from "../shared/Config.ts";
import type { AdminGuard } from "../shared/adminGuard.ts";

export type PluginContext = {
	database: Services["database"];
	redis: Services["redis"];
	services: Pick<
		Services,
		"customers" | "licenses" | "access" | "sessions" | "meters" | "activity"
	>;
	env: Environment;
	logger: Services["logger"];
	adminGuard: AdminGuard;
};

export interface Plugin {
	readonly name: string;
	create(context: PluginContext): AnyElysia;
}
