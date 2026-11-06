import type { Static } from "typebox";
import type {
	webhookEvents,
	eventContracts,
	eventEnvelopeSchema,
	publishedEventSchema,
	eventAuthoritySchema,
} from "../plugins/webhooks/events";

export type $WebhookEvent = (typeof webhookEvents)[number];
export type $EventData<E extends $WebhookEvent = $WebhookEvent> = Static<
	(typeof eventContracts)[E]["data"]
>;
/** Historical invalidations, not authoritative resource snapshots. Revision is
 * the resource's event revision; keep the highest processed revision and refetch
 * current authorized state serially before acknowledging the publication cursor. */
export type $EventEnvelope = Static<typeof eventEnvelopeSchema>;
export type $PublishedEvent = Static<typeof publishedEventSchema>;
export type $EventAuthority = Static<typeof eventAuthoritySchema>;

type Input<E extends $WebhookEvent> = E extends
	| `group.${string}`
	| "license.group_detached"
	| "license.group_attached"
	? $EventData<E>
	: E extends "validation.failed"
		? Omit<$EventData<E>, "licenseId" | "groupId"> & {
				licenseId?: string | null;
				groupId?: string | null;
				clientIp?: string;
				hardwareId?: string;
			}
		: E extends `license.${string}` | `meter.${string}` | "usage.consumed"
			? Omit<$EventData<E>, "groupId"> & { groupId?: string | null }
			: $EventData<E>;
export type $EventInput<E extends $WebhookEvent> = E extends $WebhookEvent
	? Input<E>
	: never;
