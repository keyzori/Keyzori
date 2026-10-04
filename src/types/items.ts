import type { UnwrapSchema } from "elysia";
import type { items } from "../core/database/schema/items";
import type { itemModel } from "../plugins/items/model";

export type $Item = typeof items.$inferSelect;
export type $ItemCreate = UnwrapSchema<typeof itemModel.create>;
export type $ItemUpdate = UnwrapSchema<typeof itemModel.update>;
export type $ItemEnable = UnwrapSchema<typeof itemModel.enable>;
export type $ItemDisable = UnwrapSchema<typeof itemModel.disable>;
export type $ItemRemove = UnwrapSchema<typeof itemModel.remove>;
