import { eventContracts, webhookEvents } from "../../plugins/webhooks/events";
import type { $Principal } from "../../types/auth";
import type { AuthService } from "./AuthService";
import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

type HistoricalGroups = {
	requiredGroupIds?: readonly string[];
	requiresAllGroups?: boolean;
};

/** Historical provenance is conjunctive with the event's action/current-group filter. */
export function allowsHistoricalGroups(
	principal: $Principal,
	authority: HistoricalGroups,
) {
	if (principal.kind === "root" || principal.allGroups) return true;
	return (
		!authority.requiresAllGroups &&
		(authority.requiredGroupIds ?? []).every((id) =>
			principal.groupIds.includes(id.toLowerCase()),
		)
	);
}

export function historicalGroupFilter(
	principal: $Principal,
	columns: { requiredGroupIds: AnyPgColumn; requiresAllGroups: AnyPgColumn },
) {
	if (principal.kind === "root" || principal.allGroups) return undefined;
	return and(
		eq(columns.requiresAllGroups, false),
		sql`${columns.requiredGroupIds} <@ ARRAY[${sql.join(
			principal.groupIds.map((id) => sql`${id}::uuid`),
			sql`, `,
		)}]::uuid[]`,
	);
}

/** Unknown event types never acquire a fallback permission. */
export function eventScope(event: string): string | undefined {
	const known = webhookEvents.find((candidate) => candidate === event);
	return known ? eventContracts[known].scope : undefined;
}

export function allowedEvents(auth: AuthService, principal: $Principal) {
	return webhookEvents.filter((event) => {
		const scope = eventScope(event);
		if (!scope) return false;
		try {
			auth.require(principal, scope);
			return true;
		} catch {
			return false;
		}
	});
}
