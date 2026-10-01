import type { $ApiKeys, $Requests } from "../../types/application";
import { Elysia } from "elysia";
import { createApiKey } from "./routes/create";
import { readApiKey } from "./routes/read";
import { updateApiKey } from "./routes/update";
import { deleteApiKey } from "./routes/delete";
import { enableApiKey } from "./routes/enable";
import { disableApiKey } from "./routes/disable";
import { rotateApiKey } from "./routes/rotate";

export const apiKeyRoutes = (service: $ApiKeys, requests: $Requests) =>
	new Elysia({ normalize: false })
		.use(createApiKey(service, requests))
		.use(readApiKey(service, requests))
		.use(updateApiKey(service, requests))
		.use(deleteApiKey(service, requests))
		.use(enableApiKey(service, requests))
		.use(disableApiKey(service, requests))
		.use(rotateApiKey(service, requests));
