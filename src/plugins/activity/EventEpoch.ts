import { eq, sql } from "drizzle-orm";
import { activityEvents, eventState } from "../../core/database/schema/events";
import type { $Transaction } from "../../types/database";

/** The caller quiesces serving and combines this with restore audit/delivery fencing. */
export async function resetEventEpoch(tx: $Transaction) {
	await tx
		.insert(eventState)
		.values({ id: 1, epoch: Bun.randomUUIDv7() })
		.onConflictDoNothing();
	const [current] = await tx
		.select()
		.from(eventState)
		.where(eq(eventState.id, 1))
		.for("update");
	if (!current) throw new Error("Event state unavailable");
	const [high] = await tx
		.select({
			sequence: sql<string | null>`max(${activityEvents.sequence})::text`,
		})
		.from(activityEvents);
	const maximum = BigInt(high?.sequence ?? "0");
	// Math.max cannot accept bigint operands.
	const sequence = maximum > current.sequence ? maximum : current.sequence;
	const epoch = Bun.randomUUIDv7();
	await tx
		.update(eventState)
		.set({ epoch, sequence })
		.where(eq(eventState.id, 1));
	// Do not rebase existing sequences or discard resource revision tombstones.
	return {
		epoch,
		sequence: String(sequence),
		retainedAfter: String(current.retainedAfter),
	};
}
