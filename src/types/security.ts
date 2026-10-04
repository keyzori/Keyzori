import type { UnwrapSchema } from "elysia";
import type { securityModel } from "../core/security/model";

export type $KeyFormat = UnwrapSchema<typeof securityModel.keyFormat>;
