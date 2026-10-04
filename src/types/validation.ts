import type { validationCodes } from "../plugins/validate/codes";
import type { validationModel } from "../plugins/validate/model";
import type { UnwrapSchema } from "elysia";

export type $ValidationCode = keyof typeof validationCodes;
export type $ValidationInput = UnwrapSchema<typeof validationModel.body>;
