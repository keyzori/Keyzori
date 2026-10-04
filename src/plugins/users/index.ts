import type { $Users, $Requests } from "../../types/application";
import { Elysia } from "elysia";
import { createUser } from "./routes/create";
import { readUser } from "./routes/read";
import { updateUser } from "./routes/update";
import { deleteUser } from "./routes/delete";
import { enableUser } from "./routes/enable";
import { disableUser } from "./routes/disable";

export const userRoutes = (service: $Users, requests: $Requests) =>
	new Elysia({ normalize: false })
		.use(createUser(service, requests))
		.use(readUser(service, requests))
		.use(updateUser(service, requests))
		.use(deleteUser(service, requests))
		.use(enableUser(service, requests))
		.use(disableUser(service, requests));
