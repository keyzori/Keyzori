import { and, eq, inArray, sql } from "drizzle-orm";
import { actions, type $Action } from "../auth/scopes";
import type { AuthService } from "../auth/AuthService";
import { eventScope, historicalGroupFilter } from "../auth/EventAuthorization";
import { deliveries } from "../database/schema/deliveries";
import { licenses } from "../database/schema/licenses";
import { webhooks } from "../database/schema/webhooks";
import { webhookEvents } from "../../plugins/webhooks/events";
import { HttpError } from "../http/HttpError";
import { InputPolicy } from "../http/InputPolicy";
import type { $Principal } from "../../types/auth";
import type { $Transaction } from "../../types/database";
import type { $ReceiptAuthority } from "../../types/idempotency";

type Requirements = Omit<$ReceiptAuthority, "scope">;
const ids = new InputPolicy();
const isUUID = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new HttpError("INVALID_REQUEST");
	return Object.fromEntries(Object.entries(value));
};
function strings(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
		throw new HttpError("INVALID_REQUEST");
	return value;
}
function group(value: unknown) {
	if (value == null) return null;
	if (typeof value !== "string" || !isUUID(value.toLowerCase()))
		throw new HttpError("INVALID_REQUEST");
	return value.toLowerCase();
}
function subscriptions(names: string[], principal: $Principal): $Action[] {
	const selected =
		names.length === 1 && names[0] === "*"
			? webhookEvents.filter(
					(name) =>
						principal.kind === "root" ||
						principal.scopes.includes(eventScope(name) ?? ""),
				)
			: names;
	return selected.map((name) => {
		const eventAction = eventScope(name);
		const action = actions.find((scope) => scope === eventAction);
		if (!action) throw new HttpError("FORBIDDEN");
		return action;
	});
}

/** The live authorizer already holds the target locks. Snapshot only the authority
 * actually exercised, including both sides of changes; never snapshot all caller grants.
 * Creation-ID recovery also uses these scoped reads to lock the now-existing subject. */
export async function commandRequirements(
	tx: $Transaction,
	operation: string,
	input: unknown,
	principal: $Principal,
	auth?: Pick<AuthService, "groupFilter">,
): Promise<Requirements> {
	if (principal.kind === "root") return { groupIds: [] };
	if (!auth) throw new HttpError("FORBIDDEN");
	const body = record(input);
	if (operation.startsWith("user."))
		return {
			groupIds: [],
			allGroups: true,
			scopes: operation === "user.delete" ? ["licenses:delete"] : [],
		};
	if (operation.startsWith("group.")) {
		if (operation === "group.create") return { groupIds: [], allGroups: true };
		return {
			groupIds:
				operation === "group.detach-licenses"
					? [group(body.groupId)]
					: ids.ids(strings(body.ids)),
			scopes:
				operation === "group.detach-licenses" || operation === "group.delete"
					? ["licenses:disable"]
					: [],
		};
	}
	if (operation.startsWith("license.")) {
		const changes =
			operation === "license.update" ? record(body.changes) : body;
		const scopes: $Action[] = [];
		if (changes.userId) scopes.push("users:read");
		if (operation === "license.update" && changes.meters)
			scopes.push("usage:adjust");
		if (operation === "license.create")
			return { groupIds: [group(body.groupId)], scopes };
		const targets = ids.ids(
			body.licenseId === undefined
				? strings(body.ids)
				: strings([body.licenseId]),
		);
		const rows = await tx
			.select({ groupId: licenses.groupId })
			.from(licenses)
			.where(
				and(
					inArray(licenses.id, targets),
					auth.groupFilter(principal, licenses.groupId),
				),
			)
			.for("share");
		if (rows.length !== targets.length) throw new HttpError("NOT_FOUND");
		return {
			groupIds: [
				...rows.map((row) => row.groupId),
				...(changes.groupId === undefined ? [] : [group(changes.groupId)]),
			],
			scopes,
		};
	}
	if (operation.startsWith("webhook.")) {
		const required = new Set<$Action>(["events:read"]);
		const groups = new Set<string | null>();
		let allGroups = false;
		const selection = (value: {
			events?: unknown;
			groupIds?: unknown;
			allGroups?: unknown;
		}) => {
			if (value.events !== undefined)
				for (const scope of subscriptions(strings(value.events), principal))
					required.add(scope);
			if (value.groupIds !== undefined)
				for (const id of strings(value.groupIds)) groups.add(group(id));
			allGroups ||= value.allGroups === true;
		};
		if (operation === "webhook.create") selection(body);
		else {
			let targets = ids.ids(
				strings(operation === "webhook.activate-secret" ? [body.id] : body.ids),
			);
			if (operation === "webhook.replay" || operation === "webhook.recover") {
				const rows = await tx
					.select({
						webhookId: deliveries.webhookId,
						groupId: deliveries.groupId,
						requiredGroupIds: deliveries.requiredGroupIds,
						requiresAllGroups: deliveries.requiresAllGroups,
						global: deliveries.global,
						event: sql<string>`${deliveries.payload}->>'event'`,
					})
					.from(deliveries)
					.innerJoin(webhooks, eq(webhooks.id, deliveries.webhookId))
					.where(
						and(
							inArray(deliveries.id, targets),
							eq(webhooks.ownerApiKeyId, principal.id),
							auth.groupFilter(principal, deliveries.groupId),
							historicalGroupFilter(principal, deliveries),
						),
					);
				if (rows.length !== targets.length) throw new HttpError("NOT_FOUND");
				for (const row of rows) {
					groups.add(row.groupId);
					selection({
						events: [row.event],
						groupIds: row.requiredGroupIds,
						allGroups: row.global || row.requiresAllGroups,
					});
				}
				targets = [...new Set(rows.map((row) => row.webhookId))];
			}
			const endpoints = await tx
				.select({
					events: webhooks.events,
					groupIds: webhooks.groupIds,
					allGroups: webhooks.allGroups,
				})
				.from(webhooks)
				.where(
					and(
						inArray(webhooks.id, targets),
						eq(webhooks.ownerApiKeyId, principal.id),
					),
				)
				.for("share");
			if (endpoints.length !== targets.length) throw new HttpError("NOT_FOUND");
			for (const endpoint of endpoints) selection(endpoint);
			if (operation === "webhook.update") selection(record(body.changes));
		}
		return { groupIds: [...groups], allGroups, scopes: [...required] };
	}
	throw new HttpError("FORBIDDEN");
}

export function retainedAuthority(
	scope: $ReceiptAuthority["scope"],
	requirements: Requirements,
	principal: $Principal,
): $ReceiptAuthority {
	const authority = {
		scope,
		ownerId: principal.id,
		allGroups: requirements.allGroups ?? false,
		groupIds: [
			...new Set(requirements.groupIds.map((id) => id?.toLowerCase() ?? null)),
		].sort(),
		scopes: [...new Set(requirements.scopes ?? [])].sort(),
	};
	if (
		requirements.ownerId !== undefined &&
		requirements.ownerId !== principal.id
	)
		throw new HttpError("FORBIDDEN");
	authorizeReceipt(principal, authority, scope);
	return authority;
}

/** Persisted JSON is untrusted. In v2 even empty requirements have an explicit shape. */
export function authorizeReceipt(
	principal: $Principal,
	authority: $ReceiptAuthority | null,
	scope: $ReceiptAuthority["scope"],
) {
	if (
		!authority ||
		authority.scope !== scope ||
		authority.ownerId !== principal.id ||
		typeof authority.allGroups !== "boolean" ||
		!Array.isArray(authority.groupIds) ||
		!authority.groupIds.every((id) => id === null || isUUID(id)) ||
		!Array.isArray(authority.scopes) ||
		!authority.scopes.every((action) => actions.includes(action)) ||
		Object.keys(authority).some(
			(key) =>
				!["scope", "ownerId", "allGroups", "groupIds", "scopes"].includes(key),
		)
	)
		throw new HttpError("FORBIDDEN");
	if (principal.kind === "root") return;
	if (
		!principal.scopes.includes(scope) ||
		authority.scopes.some((action) => !principal.scopes.includes(action)) ||
		(!principal.allGroups &&
			(authority.allGroups ||
				authority.groupIds.some(
					(id) => id === null || !principal.groupIds.includes(id),
				)))
	)
		throw new HttpError("FORBIDDEN");
}
