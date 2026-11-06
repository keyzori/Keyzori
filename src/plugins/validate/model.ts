import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { licenseModel } from "../licenses/model";
import { validationCodes } from "./codes";

export const validationModel = {
	body: t.Object(
		{
			license: t.String({ minLength: 1, maxLength: 4096 }),
			expectedGroupId: t.Optional(t.Union([httpModel.id, t.Null()])),
			userId: t.Optional(httpModel.id),
			hardwareId: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
		},
		{ additionalProperties: false },
	),
	response: t.Object(
		{
			data: t.Object(
				{
					valid: t.Boolean(),
					code: t.UnionEnum(["VALID", ...Object.keys(validationCodes)]),
					reason: t.String(),
					evaluatedAt: t.String({ format: "date-time" }),
					license: t.Union([licenseModel.validation, t.Null()]),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
};
