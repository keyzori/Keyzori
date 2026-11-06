import { Elysia } from "elysia";
import type { $Licenses, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { licenseModel } from "../model";

export const registerLicense = (service: $Licenses, requests: $Requests) =>
	new Elysia({ normalize: false })
		.use(
			guard(requests, "devices:register").post(
				"/licenses/hardware/register",
				{
					body: licenseModel.register,
					response: licenseModel.result,
					detail: {
						tags: ["License"],
						summary: "Register a device before validating a device-limited key",
						security: [{ bearerAuth: [] }],
						"x-required-scope": "devices:register",
					},
				},
				({ body, operation }) => service.register(body, operation, "device"),
			),
		)
		.use(
			guard(requests, "ips:register").post(
				"/licenses/ips/register",
				{
					body: licenseModel.register,
					response: licenseModel.result,
					detail: {
						tags: ["License"],
						summary: "Register an IP before validating an IP-limited key",
						security: [{ bearerAuth: [] }],
						"x-required-scope": "ips:register",
					},
				},
				({ body, operation }) => service.register(body, operation, "ip"),
			),
		);
