import type { $Groups, $Requests } from "../../types/application";
import { Elysia } from "elysia";
import { detachGroupLicenses } from "./routes/detach-licenses";
import { createGroup } from "./routes/create";
import { readGroup } from "./routes/read";
import { updateGroup } from "./routes/update";
import { deleteGroup } from "./routes/delete";
import { enableGroup } from "./routes/enable";
import { disableGroup } from "./routes/disable";

export const groupRoutes = (service: $Groups, requests: $Requests) =>
	new Elysia({ normalize: false })
		.use(detachGroupLicenses(service, requests))
		.use(createGroup(service, requests))
		.use(readGroup(service, requests))
		.use(updateGroup(service, requests))
		.use(deleteGroup(service, requests))
		.use(enableGroup(service, requests))
		.use(disableGroup(service, requests));
