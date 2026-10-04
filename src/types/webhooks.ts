import type { webhookEvents } from "../plugins/webhooks/events";

export type $WebhookEvent = (typeof webhookEvents)[number];
export type $EventData = {
	licenseId?: string;
	userId?: string;
	itemId?: string;
	meter?: string;
	value?: string;
	limit?: string;
	code?: string;
	clientIp?: string;
	hardwareId?: string;
};
export type $EventEnvelope = {
	id: string;
	event: $WebhookEvent;
	createdAt: string;
	data: $EventData;
};
