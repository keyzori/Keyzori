import { eq } from "drizzle-orm";
import { webhooks } from "../../core/database/schema/webhooks";
import { deliveries } from "../../core/database/schema/deliveries";
import type { $Transaction } from "../../types/database";
import type {
	$WebhookEvent,
	$EventData,
	$EventEnvelope,
} from "../../types/webhooks";

export class EventService {
	async emit(
		tx: $Transaction,
		event: $WebhookEvent,
		data: $EventData,
		now = new Date(),
	) {
		const payload: $EventEnvelope = {
			id: Bun.randomUUIDv7(),
			event,
			data,
			createdAt: now.toISOString(),
		};
		const endpoints = await tx
			.select()
			.from(webhooks)
			.where(eq(webhooks.enabled, true));
		for (const endpoint of endpoints) {
			if (!endpoint.events.includes("*") && !endpoint.events.includes(event))
				continue;
			await tx
				.insert(deliveries)
				.values({ id: Bun.randomUUIDv7(), webhookId: endpoint.id, payload });
		}
	}
}
