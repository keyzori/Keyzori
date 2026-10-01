import type { UnwrapSchema } from "elysia";
import type { meterModel } from "../plugins/licenses/meterModel";
import type { meters } from "../core/database/schema/meters";

export type $MeterSchedule = UnwrapSchema<typeof meterModel.schedule>;
export type $MeterDefinition = UnwrapSchema<typeof meterModel.definition>;
export type $MeterChanges = UnwrapSchema<typeof meterModel.changes>;
export type $Meter = typeof meters.$inferSelect;
