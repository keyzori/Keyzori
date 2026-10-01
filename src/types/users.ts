import type { UnwrapSchema } from "elysia";
import type { users } from "../core/database/schema/users";
import type { userModel } from "../plugins/users/model";

export type $User = typeof users.$inferSelect;
export type $UserCreate = UnwrapSchema<typeof userModel.create>;
export type $UserUpdate = UnwrapSchema<typeof userModel.update>;
export type $UserEnable = UnwrapSchema<typeof userModel.enable>;
export type $UserDisable = UnwrapSchema<typeof userModel.disable>;
export type $UserRemove = UnwrapSchema<typeof userModel.remove>;
