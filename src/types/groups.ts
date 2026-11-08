import type { UnwrapSchema } from "elysia";
import type { groups } from "../core/database/schema/groups";
import type { groupModel } from "../plugins/groups/model";

export type $Group = typeof groups.$inferSelect;
export type $GroupCreate = UnwrapSchema<typeof groupModel.create>;
export type $GroupUpdate = UnwrapSchema<typeof groupModel.update>;
export type $GroupEnable = UnwrapSchema<typeof groupModel.enable>;
export type $GroupDisable = UnwrapSchema<typeof groupModel.disable>;
export type $GroupRemove = UnwrapSchema<typeof groupModel.remove>;
