import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { validationCodes } from "./codes";

export const validationModel = {
	body: t.Object(
		{
			license: t.String({ minLength: 1, maxLength: 4096 }),
			userId: t.Optional(httpModel.id),
			itemId: t.Optional(httpModel.id),
			hardwareId: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
			usage: t.Optional(
				t.Record(
					t.String({ minLength: 1, maxLength: 128 }),
					t.Number({ exclusiveMinimum: 0, maximum: 999999999999999 }),
					{ maxProperties: 128 },
				),
			),
		},
		{ additionalProperties: false },
	),
	response: t.Object(
		{
			code: t.UnionEnum(["VALID", ...Object.keys(validationCodes)]),
			reason: t.UnionEnum([
				validationCodes.VALID,
				...Object.values(validationCodes),
			]),
		},
		{ additionalProperties: false },
	),
};
