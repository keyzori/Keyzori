import type { UnwrapSchema } from "elysia";
import type { apiKeyModel } from "../plugins/api-keys/model";
import type { apiKeys } from "../core/database/schema/apiKeys";

export type $ApiKey = typeof apiKeys.$inferSelect;
export type $ApiKeyCreate = UnwrapSchema<typeof apiKeyModel.create>;
export type $ApiKeyUpdate = UnwrapSchema<typeof apiKeyModel.update>;
export type $ApiKeyAction = UnwrapSchema<typeof apiKeyModel.action>;
export type $ApiKeyDelete = UnwrapSchema<typeof apiKeyModel.delete>;
