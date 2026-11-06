import type { UnwrapSchema } from "elysia";
import type { meterModel } from "../plugins/licenses/meterModel";
import type { meters } from "../core/database/schema/meters";

export type $MeterSchedule = UnwrapSchema<typeof meterModel.schedule>;
export type $MeterDefinition = UnwrapSchema<typeof meterModel.definition>;
export type $MeterChanges = UnwrapSchema<typeof meterModel.changes>;
export type $Meter = typeof meters.$inferSelect;
export type $MeterView = UnwrapSchema<typeof meterModel.resource>;

/**
 * Exact balances and immutable identity for an accepted increment.
 * Definition edits advance definitionRevision; manual resets advance resetGeneration.
 * Calendar resets change the period boundaries. Null boundaries mean a lifetime period.
 */
export type $UsageEntry = UnwrapSchema<typeof meterModel.usageEntry>;
