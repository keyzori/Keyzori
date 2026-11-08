import { t } from "elysia";
import { guard } from "../../../core/http/guard";
import { httpModel } from "../../../core/http/model";
import type { $Groups, $Requests } from "../../../types/application";
import { groupModel } from "../model";

export const detachGroupLicenses = (service: $Groups, requests: $Requests) =>
	guard(requests, "groups:delete").post(
		"/groups/detach-licenses",
		{
			body: t.Object(
				{ groupId: httpModel.id, ids: httpModel.ids, reason: httpModel.reason },
				{ additionalProperties: false },
			),
			response: groupModel.removeResponse,
			detail: {
				tags: ["Groups"],
				security: [{ bearerAuth: [] }],
				"x-required-scope": "groups:delete",
				description:
					"Also requires licenses:disable. Disables and detaches up to 100 keys before large group deletion.",
			},
		},
		({ body, operation }) => service.detachLicenses(body, operation),
	);
