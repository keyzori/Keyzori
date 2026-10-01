import type { $Licenses, $Requests } from "../../types/application";
import { Elysia } from "elysia";
import { createLicense } from "./routes/create";
import { readLicense } from "./routes/read";
import { updateLicense } from "./routes/update";
import { deleteLicense } from "./routes/delete";
import { enableLicense } from "./routes/enable";
import { disableLicense } from "./routes/disable";
import { rotateLicense } from "./routes/rotate";
import { adjustMeterLicense } from "./routes/adjust-meter";
import { removeHardwareLicense } from "./routes/remove-hardware";
import { removeIpLicense } from "./routes/remove-ip";
import { selfLicense } from "./routes/self";

export const licenseRoutes = (service: $Licenses, requests: $Requests) =>
	new Elysia({ normalize: false })
		.use(createLicense(service, requests))
		.use(readLicense(service, requests))
		.use(updateLicense(service, requests))
		.use(deleteLicense(service, requests))
		.use(enableLicense(service, requests))
		.use(disableLicense(service, requests))
		.use(rotateLicense(service, requests))
		.use(adjustMeterLicense(service, requests))
		.use(removeHardwareLicense(service, requests))
		.use(removeIpLicense(service, requests))
		.use(selfLicense(service, requests));
