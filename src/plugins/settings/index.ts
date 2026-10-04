import { Elysia } from "elysia";
import type { $Requests, $Settings } from "../../types/application";
import { readSettings } from "./routes/read";
import { updateSettings } from "./routes/update";

export const settingsRoutes = (service: $Settings, requests: $Requests) =>
	new Elysia({ normalize: false })
		.use(readSettings(service, requests))
		.use(updateSettings(service, requests));
