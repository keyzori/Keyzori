import type { UnwrapSchema } from "elysia";
import type { deliveries } from "../core/database/schema/deliveries";
import type { webhooks } from "../core/database/schema/webhooks";
import type { webhookModel } from "../plugins/webhooks/model";

export type $Webhook = typeof webhooks.$inferSelect;
export type $WebhookDelivery = typeof deliveries.$inferSelect;
export type $WebhookClaim = Pick<$WebhookDelivery, "id" | "payload"> & {
	url: string;
	timeoutMs: number;
};
export type $WebhookCreate = UnwrapSchema<typeof webhookModel.create>;
export type $WebhookUpdate = UnwrapSchema<typeof webhookModel.update>;
export type $WebhookAction = UnwrapSchema<typeof webhookModel.enable>;
export type $WebhookDelete = UnwrapSchema<typeof webhookModel.delete>;
