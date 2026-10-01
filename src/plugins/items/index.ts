import type { $Items, $Requests } from "../../types/application";
import { Elysia } from "elysia";
import { createItem } from "./routes/create";
import { readItem } from "./routes/read";
import { updateItem } from "./routes/update";
import { deleteItem } from "./routes/delete";
import { enableItem } from "./routes/enable";
import { disableItem } from "./routes/disable";

export const itemRoutes = (service: $Items, requests: $Requests) =>
	new Elysia({ normalize: false })
		.use(createItem(service, requests))
		.use(readItem(service, requests))
		.use(updateItem(service, requests))
		.use(deleteItem(service, requests))
		.use(enableItem(service, requests))
		.use(disableItem(service, requests));
