import { expect, test } from "bun:test";
import {
	adminReceiptContract,
	checkAdminResult,
	replayProjection,
} from "../../core/security/adminReceipts";
import {
	authorizeReceipt,
	retainedAuthority,
} from "../../core/security/ReceiptAuthority";
import type { $Principal } from "../../types/auth";

const id = Bun.randomUUIDv7();
const writer: $Principal = {
	kind: "api",
	id: Bun.randomUUIDv7(),
	name: "Writer",
	credentialHash: "fixture-only",
	grantGeneration: "4",
	expiresAt: null,
	scopes: ["groups:update", "users:create"],
	allGroups: false,
	groupIds: [id],
};
const resource = {
	id,
	name: "Group",
	enabled: true,
	metadata: {},
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
	notes: "Private fixture",
	disabledReason: null,
	createdBy: "root",
	updatedBy: "root",
	keyFormat: null,
};

test("replay reprojects a previously rich result through the current read policy; malformed results fail before projection", () => {
	const rich = { data: [resource] };
	const reader = { ...writer, scopes: [...writer.scopes, "groups:read"] };
	expect(() => checkAdminResult("group.update", rich, writer)).toThrow();
	expect(() =>
		checkAdminResult("group.update", { data: [{ id }] }, writer),
	).not.toThrow();
	expect(() => checkAdminResult("group.update", rich, reader)).not.toThrow();
	expect(replayProjection("group.update", rich, reader)).toEqual(rich);
	expect(replayProjection("group.update", rich, writer)).toEqual({
		data: [{ id }],
	});
	const { keyFormat: _keyFormat, ...user } = resource;
	expect(replayProjection("user.create", { data: user }, writer)).toEqual({
		data: { id },
	});
	for (const principal of [reader, writer]) {
		expect(() =>
			replayProjection(
				"group.update",
				{ data: [{ ...resource, secret: "marker" }] },
				principal,
			),
		).toThrow();
	}
	expect(() => adminReceiptContract("unknown.future-command")).toThrow();
	expect(adminReceiptContract("webhook.activate-secret").scope).toBe(
		"webhooks:rotate-secret",
	);
	expect(() =>
		checkAdminResult("webhook.activate-secret", {
			data: { id, signingKeyId: id },
		}),
	).not.toThrow();
	expect(() =>
		checkAdminResult("webhook.activate-secret", {
			data: { id, signingKeyId: id, secret: "marker" },
		}),
	).toThrow();
});

test("versioned receipt requirements are exact, owner-bound and independent of unrelated grants or credential generation", () => {
	const requirements = retainedAuthority(
		"groups:update",
		{ groupIds: [id, id] },
		writer,
	);
	expect(requirements.groupIds).toEqual([id]);
	expect(() =>
		authorizeReceipt(
			{
				...writer,
				credentialHash: "rotated",
				grantGeneration: "18",
				scopes: ["groups:update"],
			},
			requirements,
			"groups:update",
		),
	).not.toThrow();
	for (const principal of [
		{ ...writer, groupIds: [] },
		{ ...writer, id: Bun.randomUUIDv7() },
		{ ...writer, scopes: [] },
	]) {
		expect(() =>
			authorizeReceipt(principal, requirements, "groups:update"),
		).toThrow();
	}
	for (const malformed of [
		null,
		{ ...requirements, scopes: undefined },
		{ ...requirements, ownerId: undefined },
		{ ...requirements, allGroups: undefined },
	]) {
		expect(() =>
			authorizeReceipt(writer, malformed, "groups:update"),
		).toThrow();
	}
});
