import { Elysia } from "elysia";
import type { $Health } from "../../types/application";
import { readHealth } from "./routes/read";

export const healthRoutes = (service: $Health) =>
	new Elysia({ normalize: false }).use(readHealth(service));
