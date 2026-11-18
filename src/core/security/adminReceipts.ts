import { t, TypeBoxValidator } from "elysia";
import type { TSchema } from "typebox";
import { apiKeyModel } from "../../plugins/api-keys/model";
import { groupModel } from "../../plugins/groups/model";
import { licenseModel } from "../../plugins/licenses/model";
import { settingsModel } from "../../plugins/settings/model";
import { userModel } from "../../plugins/users/model";
import { webhookModel } from "../../plugins/webhooks/model";
import { httpModel, metadataDefinitions } from "../http/model";
import { HttpError } from "../http/HttpError";
import type { $Action } from "../auth/scopes";
import type { $Principal } from "../../types/auth";

type ResultContract = {
	scope: $Action | "root";
	schema: TSchema;
	issued?: true;
	richScope?: $Action;
};
const ids = licenseModel.result;
function result(
	scope: ResultContract["scope"],
	schema: TSchema = ids,
	disclosure?: "issued" | $Action,
): ResultContract {
	return {
		scope,
		schema,
		...(disclosure === "issued" ? { issued: true } : { richScope: disclosure }),
	};
}
const settingsResult = t.Object(
	{ data: settingsModel.value },
	{ additionalProperties: false },
);
const contracts = new Map(
	Object.entries({
		"license.create": result("licenses:create", licenseModel.issued, "issued"),
		"license.update": result("licenses:update"),
		"license.enable": result("licenses:enable"),
		"license.disable": result("licenses:disable"),
		"license.delete": result("licenses:delete"),
		"license.rotate": result("licenses:rotate", licenseModel.rotated, "issued"),
		"license.meter.adjust": result("usage:adjust"),
		"license.device.register": result("devices:register"),
		"license.ip.register": result("ips:register"),
		"license.hardware.remove": result("devices:remove"),
		"license.ips.remove": result("ips:remove"),
		"group.create": result("groups:create", groupModel.created, "groups:read"),
		"group.update": result(
			"groups:update",
			groupModel.bulkResponse,
			"groups:read",
		),
		"group.enabled": result(
			"groups:enable",
			groupModel.bulkResponse,
			"groups:read",
		),
		"group.disabled": result(
			"groups:disable",
			groupModel.bulkResponse,
			"groups:read",
		),
		"group.delete": result("groups:delete"),
		"group.detach-licenses": result("groups:delete"),
		"user.create": result("users:create", userModel.created, "users:read"),
		"user.update": result("users:update", userModel.bulkResponse, "users:read"),
		"user.enabled": result(
			"users:enable",
			userModel.bulkResponse,
			"users:read",
		),
		"user.disabled": result(
			"users:disable",
			userModel.bulkResponse,
			"users:read",
		),
		"user.delete": result("users:delete"),
		"webhook.create": result(
			"webhooks:create",
			webhookModel.singleResponse,
			"issued",
		),
		"webhook.update": result(
			"webhooks:update",
			webhookModel.bulkResponse,
			"webhooks:read",
		),
		"webhook.enable": result(
			"webhooks:enable",
			webhookModel.bulkResponse,
			"webhooks:read",
		),
		"webhook.disable": result(
			"webhooks:disable",
			webhookModel.bulkResponse,
			"webhooks:read",
		),
		"webhook.delete": result("webhooks:delete"),
		"webhook.rotate-secret": result(
			"webhooks:rotate-secret",
			webhookModel.rotatedResponse,
			"issued",
		),
		"webhook.activate-secret": result(
			"webhooks:rotate-secret",
			webhookModel.activatedResponse,
		),
		"webhook.replay": result("webhooks:replay", webhookModel.recoveryResponse),
		"webhook.recover": result(
			"webhooks:recover",
			webhookModel.recoveryResponse,
		),
		"api-key.create": result("root", apiKeyModel.issued, "issued"),
		"api-key.rotate": result("root", apiKeyModel.rotated, "issued"),
		"api-key.update": result("root", apiKeyModel.result),
		"api-key.delete": result("root", apiKeyModel.result),
		"api-key.enable": result("root", apiKeyModel.result),
		"api-key.disable": result("root", apiKeyModel.result),
		"settings.update": result("root", settingsResult),
	}),
);

const checks = new WeakMap<TSchema, TypeBoxValidator<TSchema>>();
function valid(schema: TSchema, value: unknown) {
	let check = checks.get(schema);
	if (!check) {
		check = new TypeBoxValidator(schema, {
			normalize: false,
			models: metadataDefinitions,
		});
		checks.set(schema, check);
	}
	return check.Check(value);
}

export function adminReceiptContract(operation: string) {
	const contract = contracts.get(operation);
	if (!contract) throw new Error("Missing administrative result policy");
	return contract;
}

/** Validate inside the mutation transaction, and again when reading stored JSON. */
export function checkAdminResult(
	operation: string,
	value: unknown,
	principal?: $Principal,
): asserts value is Record<string, unknown> {
	const contract = adminReceiptContract(operation);
	if (!valid(contract.schema, value)) throw new HttpError("INTERNAL_ERROR");
	if (principal?.kind !== "api") return;
	// Issuance can return a credential, but not a related parent's private notes
	// to a create-only key. For parent mutations only ID acknowledgments qualify.
	const required =
		operation === "license.create"
			? "licenses:read"
			: operation.startsWith("group.") || operation.startsWith("user.")
				? contract.richScope
				: undefined;
	if (!required || principal.scopes.includes(required)) return;
	const data =
		value && typeof value === "object" && "data" in value
			? value.data
			: undefined;
	const idOnly = (row: unknown) =>
		row !== null &&
		typeof row === "object" &&
		Object.keys(row).length === 1 &&
		Object.hasOwn(row, "id");
	if (!(Array.isArray(data) ? data.every(idOnly) : idOnly(data)))
		throw new HttpError("INTERNAL_ERROR");
}

export function checkIssuedIds(value: unknown): asserts value is string[] {
	if (!valid(httpModel.ids, value)) throw new HttpError("INTERNAL_ERROR");
}

/** Receipts may outlive a read grant even when the original write still qualifies. */
export function replayProjection(
	operation: string,
	result: Record<string, unknown>,
	principal: $Principal,
) {
	checkAdminResult(operation, result);
	const { richScope } = adminReceiptContract(operation);
	if (
		!richScope ||
		principal.kind === "root" ||
		principal.scopes.includes(richScope)
	)
		return result;
	const onlyId = (row: unknown): row is { id: string } =>
		row !== null &&
		typeof row === "object" &&
		"id" in row &&
		typeof row.id === "string";
	const value = result.data;
	if (valid(ids, result)) return result;
	const minimal =
		Array.isArray(value) && value.every(onlyId)
			? { data: value.map(({ id }) => ({ id })) }
			: onlyId(value)
				? { data: { id: value.id } }
				: undefined;
	if (minimal && valid(adminReceiptContract(operation).schema, minimal))
		return minimal;
	// A route with no documented minimal shape must decline the disclosure.
	throw new HttpError("FORBIDDEN");
}
