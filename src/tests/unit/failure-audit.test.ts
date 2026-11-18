import { expect, test } from "bun:test";
import { FailureAuditService } from "../../plugins/audits/FailureAuditService";
import { settingsDefaults } from "../../plugins/settings/defaults";

test("only an explicit Redis suppression skips failure evidence; a malformed or unavailable gate fails closed", async () => {
	const context = { clientIp: "192.0.2.12", requestId: Bun.randomUUIDv7() };
	for (const reply of [
		0,
		null,
		false,
		"1",
		1,
		"unexpected",
		new Error("fixture unavailable"),
	]) {
		let databaseCalls = 0;
		const service = new FailureAuditService(
			{
				transaction: async () => {
					databaseCalls++;
					throw new Error("Unexpected evidence transaction");
				},
			},
			{
				send: async () => {
					if (reply instanceof Error) throw reply;
					return reply;
				},
			},
			{ recordOnce: async () => true },
			{
				emit: async () => {
					throw new Error("Unexpected event");
				},
			},
			{ read: async () => settingsDefaults },
		);
		const operation = service.record("LICENSE_INVALID", undefined, context);
		if (reply === 0) await operation;
		else
			await expect(operation).rejects.toMatchObject({
				code: "SERVICE_UNAVAILABLE",
			});
		expect(databaseCalls).toBe(0);
	}
});
