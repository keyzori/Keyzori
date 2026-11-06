import assert from "node:assert/strict";
import type { Database } from "../../core/database/Database";
import type { RuntimeContract } from "./RuntimeContract";

/** Observe the real process scheduler, never call MaintenanceService directly. */
export async function verifyRuntimeMaintenance(
	contract: RuntimeContract,
	database: Database,
) {
	const receiptKey = Bun.randomUUIDv7();
	const license = await contract.data(
		"/licenses",
		"POST",
		{
			meters: {
				upsert: [
					{
						name: "scheduled",
						limit: "10",
						schedule: { interval: "day", time: "00:00", timezone: "UTC" },
					},
				],
			},
		},
		true,
		receiptKey,
	);
	assert.equal(typeof license.id, "string");
	const id = String(license.id);
	await database.client.begin(async (sql) => {
		await sql`select id from licenses where id=${id} for update`;
		await sql`update license_meters set value=7,
			period_started_at=date_trunc('day',clock_timestamp())-interval '2 days',
			next_reset_at=date_trunc('day',clock_timestamp())-interval '1 day'
			where license_id=${id}`;
		await sql`update idempotency_receipts set expires_at=clock_timestamp()-interval '1 minute'
			where operation='license.create' and principal_id='root' and key=${receiptKey}`;
	});
	const deadline = Date.now() + 75000;
	let observed = false;
	while (Date.now() < deadline) {
		const [row] = await database.client`
			select exists(select 1 from license_meters where license_id=${id} and value=0 and last_reset_at is not null) as reset,
			not exists(select 1 from idempotency_receipts where operation='license.create' and principal_id='root' and key=${receiptKey}) as pruned,
			exists(select 1 from audit_logs where target_id=${id} and action='meter.reset' and actor->>'kind'='system') as audited`;
		if (row?.reset && row.pruned && row.audited) {
			observed = true;
			break;
		}
		await Bun.sleep(250);
	}
	assert.ok(
		observed,
		"Actual runtime scheduler did not reset, audit and prune expired receipts within its minute budget",
	);
	await contract.envelope("/licenses", "DELETE", {
		ids: [id],
		confirm: true,
		reason: "Scheduled runtime fixture cleanup",
	});
}
