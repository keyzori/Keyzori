import type { UnwrapSchema } from "elysia";
import type { settingsModel } from "../plugins/settings/model";

export type $Settings = UnwrapSchema<typeof settingsModel.value>;
export type $SettingsChanges = UnwrapSchema<typeof settingsModel.changes>;
