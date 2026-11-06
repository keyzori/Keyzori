import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityEvents } from "../../core/database/schema/events";
import {
	deliveries,
	deliveryAttempts,
} from "../../core/database/schema/deliveries";
import { webhooks } from "../../core/database/schema/webhooks";
import { groups } from "../../core/database/schema/groups";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { WebhookService } from "../../plugins/webhooks/WebhookService";
import { WebhookDispatcher } from "../../plugins/webhooks/WebhookDispatcher";
import { WebhookTransport } from "../../plugins/webhooks/WebhookTransport";
import { TestContext } from "../fixtures/TestContext";
import { Replay } from "../../core/security/Replay";
import type { $WebhookClaim } from "../../types/webhookManagement";
import type { $EventAuthority } from "../../types/webhooks";
import { webhookTlsFixture } from "./webhook-tls.fixture";

const context = new TestContext();
const encryptionKey = "c".repeat(64);
const service = new WebhookService(
	context.database,
	context.auth,
	context.audit,
	context.settings,
	context.idempotency,
	{ encryptionKey },
);
const activity = new ActivityService(
	context.database,
	context.auth,
	context.redis,
);
const dispatcher = () =>
	new WebhookDispatcher(
		context.database,
		context.settings,
		undefined,
		context.auth,
		encryptionKey,
	);
beforeAll(() => context.start());
afterAll(() => context.stop());
beforeEach(async () => {
	await context.database.orm.delete(deliveries);
	await context.database.orm.delete(webhooks);
	await context.database.orm.delete(activityEvents);
});

async function endpoint() {
	const created = await service.create(
		{
			url: "https://receiver.example/events",
			events: ["license.created"],
			allGroups: true,
		},
		context.operation(),
	);
	await service.enable({ ids: [created.data.id] }, context.operation());
	return created;
}
async function event(
	groupId: string | null = null,
	authority: $EventAuthority = {},
) {
	await context.database.transaction((tx) =>
		context.events.emit(
			tx,
			"license.created",
			{
				licenseId: Bun.randomUUIDv7(),
				groupId,
			},
			new Date(),
			authority,
		),
	);
	await activity.publish();
}

test("events survive without subscribers and rolled-back events never publish", async () => {
	await event();
	expect(await context.database.orm.select().from(activityEvents)).toHaveLength(
		1,
	);
	await expect(
		context.database.transaction(async (tx) => {
			await context.events.emit(tx, "license.created", {
				licenseId: Bun.randomUUIDv7(),
				groupId: null,
			});
			throw new Error("Rollback");
		}),
	).rejects.toThrow("Rollback");
	expect(await context.database.orm.select().from(activityEvents)).toHaveLength(
		1,
	);
	const hook = await endpoint();
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await dispatcher().runOnce();
		expect(sent).not.toHaveBeenCalled();
		await event();
		await dispatcher().runOnce();
		expect(sent).toHaveBeenCalledTimes(1);
		const call = sent.mock.calls[0];
		if (!call) throw new Error("Missing outbound request");
		const [, body, headers] = call;
		const expected = createHmac("sha256", Buffer.from(hook.secret, "hex"))
			.update(
				`${headers["X-Keyzori-Timestamp"]}.${headers["X-Keyzori-Delivery-Id"]}.${body}`,
			)
			.digest("hex");
		expect(headers["X-Keyzori-Signature"]).toBe(`v1=${expected}`);
		expect(headers["X-Keyzori-Signing-Key-Id"]).toBe(hook.data.signingKeyId);
		const [delivery] = await context.database.orm.select().from(deliveries);
		expect(delivery).toMatchObject({ state: "succeeded", attempts: 1 });
		const listed = await service.read(
			new URLSearchParams({ id: hook.data.id }),
			context.operation(),
		);
		expect(JSON.stringify(listed)).not.toContain(hook.secret);
	} finally {
		sent.mockRestore();
	}
});

test("transient failures retry with the same delivery/event IDs and recorded attempts", async () => {
	await endpoint();
	await event();
	const sent = spyOn(WebhookTransport.prototype, "send")
		.mockResolvedValueOnce({ status: 503, retryAfter: "1" })
		.mockResolvedValue({ status: 204, retryAfter: null });
	try {
		await dispatcher().runOnce();
		const [failed] = await context.database.orm.select().from(deliveries);
		if (!failed) throw new Error("Missing delivery");
		expect(failed).toMatchObject({
			state: "pending",
			attempts: 1,
			status: 503,
		});
		expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20000);
		await context.database.orm
			.update(deliveries)
			.set({ nextAttemptAt: new Date(0) })
			.where(eq(deliveries.id, failed.id));
		await dispatcher().runOnce();
		const [succeeded] = await context.database.orm.select().from(deliveries);
		expect(succeeded).toMatchObject({
			id: failed.id,
			eventId: failed.eventId,
			state: "succeeded",
			attempts: 2,
		});
		expect(
			await context.database.orm.select().from(deliveryAttempts),
		).toHaveLength(2);
	} finally {
		sent.mockRestore();
	}
});

test("destination changes cancel queued events and require explicit re-enablement", async () => {
	const hook = await endpoint();
	await event();
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 503,
		retryAfter: null,
	});
	try {
		await dispatcher().runOnce();
		await service.update(
			{
				ids: [hook.data.id],
				changes: { url: "https://new-receiver.example/events" },
			},
			context.operation(),
		);
		const [delivery] = await context.database.orm.select().from(deliveries);
		expect(delivery).toMatchObject({
			state: "cancelled",
			url: "https://receiver.example/events",
		});
		const [stored] = await context.database.orm.select().from(webhooks);
		expect(stored).toMatchObject({ enabled: false, version: 2 });
		await dispatcher().runOnce();
		expect(sent).toHaveBeenCalledTimes(1);
	} finally {
		sent.mockRestore();
	}
});

test("revoked owners cannot deliver, retarget other endpoints or subscribe beyond their groups", async () => {
	const groupId = Bun.randomUUIDv7();
	await context.database.orm.insert(groups).values({
		id: groupId,
		name: "Selected",
		createdBy: "root",
		updatedBy: "root",
	});
	const issued = await context.apiKeys.create(
		{ name: "Webhook owner" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [issued.data.id],
			changes: {
				scopes: ["webhooks:*", "events:read", "licenses:read"],
				groupIds: [groupId],
			},
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [issued.data.id] }, context.operation());
	const principal = await context.auth.authenticate(
		`Bearer ${issued.credential}`,
	);
	const operation = () => ({ ...context.operation(), principal });
	await expect(
		service.create(
			{
				url: "https://receiver.example/",
				events: ["user.created"],
				groupIds: [groupId],
			},
			operation(),
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		service.create(
			{
				url: "https://receiver.example/",
				events: ["license.created"],
				allGroups: true,
			},
			operation(),
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const own = await service.create(
		{
			url: "https://receiver.example/",
			events: ["license.created"],
			groupIds: [groupId],
		},
		operation(),
	);
	await service.enable({ ids: [own.data.id] }, operation());
	const other = await endpoint();
	await expect(
		service.update(
			{ ids: [other.data.id], changes: { url: "https://attacker.example/" } },
			operation(),
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await service.disable({ ids: [other.data.id] }, context.operation());
	await event(null);
	await event(groupId);
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await dispatcher().runOnce();
		expect(sent).toHaveBeenCalledTimes(1);
		await context.apiKeys.disable(
			{ ids: [issued.data.id] },
			context.operation(),
		);
		await event(groupId);
		await dispatcher().runOnce();
		expect(sent).toHaveBeenCalledTimes(1);
		const [stored] = await context.database.orm
			.select()
			.from(webhooks)
			.where(eq(webhooks.id, own.data.id));
		expect(stored).toMatchObject({
			enabled: false,
			lastError: "owner_authority_revoked",
		});
	} finally {
		sent.mockRestore();
	}
});

test("expired claims recover uncertain outcomes without exceeding the attempt limit", async () => {
	await endpoint();
	await event();
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 503,
		retryAfter: null,
	});
	try {
		await dispatcher().runOnce();
		const [delivery] = await context.database.orm.select().from(deliveries);
		if (!delivery) throw new Error("Missing delivery");
		const token = Bun.randomUUIDv7();
		await context.database.orm.insert(deliveryAttempts).values({
			id: token,
			deliveryId: delivery.id,
			attempt: 2,
			startedAt: new Date(0),
			sendStartedAt: new Date(0),
		});
		await context.database.orm
			.update(deliveries)
			.set({
				state: "claimed",
				attempts: 2,
				claimToken: token,
				leaseUntil: new Date(0),
				nextAttemptAt: new Date(0),
			})
			.where(eq(deliveries.id, delivery.id));
		await dispatcher().runOnce();
		const [recovered] = await context.database.orm
			.select()
			.from(deliveryAttempts)
			.where(eq(deliveryAttempts.id, token));
		expect(recovered?.error).toBe("lease_expired_outcome_unknown");
		await context.database.orm
			.update(deliveries)
			.set({ attempts: 8, nextAttemptAt: new Date(0) })
			.where(eq(deliveries.id, delivery.id));
		await dispatcher().runOnce();
		const [terminal] = await context.database.orm
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, delivery.id));
		expect(terminal).toMatchObject({
			state: "failed",
			attempts: 8,
			error: "retry_window_exhausted",
		});
		expect(sent).toHaveBeenCalledTimes(2);
	} finally {
		sent.mockRestore();
	}
});

test("signing rotation preserves queued secret versions and never stores plaintext", async () => {
	const hook = await endpoint();
	await event();
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 503,
		retryAfter: null,
	});
	try {
		await dispatcher().runOnce();
		const rotated = await service.rotateSecret(
			{ ids: [hook.data.id] },
			context.operation(),
		);
		const [queued] = await context.database.orm.select().from(deliveries);
		const [stored] = await context.database.orm.select().from(webhooks);
		expect(queued?.signingKeyId).toBe(hook.data.signingKeyId);
		expect(stored?.signingKeyId).toBe(rotated.data[0]?.signingKeyId);
		expect(
			JSON.stringify([queued, stored], (_key, value) =>
				typeof value === "bigint" ? String(value) : value,
			),
		).not.toContain(hook.secret);
	} finally {
		sent.mockRestore();
	}
});

test("two dispatchers do not concurrently send the same endpoint", async () => {
	await endpoint();
	await event();
	await event();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const sent = spyOn(WebhookTransport.prototype, "send").mockImplementation(
		async () => {
			started.resolve();
			await release.promise;
			return { status: 204, retryAfter: null };
		},
	);
	const first = dispatcher().runOnce();
	try {
		await started.promise;
		await dispatcher().runOnce();
		expect(sent).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
		await first;
		sent.mockRestore();
	}
});

// Intentional crash boundaries: exercise committed claims independently of the worker loop.
function probe(worker: WebhookDispatcher) {
	return worker as unknown as {
		enqueue(id: string): Promise<void>;
		claim(id: string, webhookId: string): Promise<$WebhookClaim | undefined>;
		send(claim: $WebhookClaim): Promise<void>;
		settle(
			claim: $WebhookClaim,
			outcome: { status?: number; error: string | null; retry?: boolean },
		): Promise<void>;
	};
}
async function queuedClaim() {
	const hook = await endpoint();
	await event();
	const worker = dispatcher();
	await probe(worker).enqueue(hook.data.id);
	const [delivery] = await context.database.orm.select().from(deliveries);
	if (!delivery) throw new Error("Missing queued delivery");
	const claim = await probe(worker).claim(delivery.id, hook.data.id);
	if (!claim) throw new Error("Missing claim");
	return { hook, worker, claim };
}

test("a lease expiring before send stays reclaimable without consuming a send attempt", async () => {
	const { worker, claim } = await queuedClaim();
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await context.database.orm
			.update(deliveries)
			.set({ leaseUntil: new Date(0) })
			.where(eq(deliveries.id, claim.id));
		await probe(worker).send(claim);
		expect(sent).not.toHaveBeenCalled();
		const [unsent] = await context.database.orm.select().from(deliveries);
		expect(unsent).toMatchObject({
			state: "claimed",
			attempts: 0,
			claimToken: claim.claimToken,
		});
		await dispatcher().runOnce();
		const [delivered] = await context.database.orm.select().from(deliveries);
		expect(delivered).toMatchObject({
			id: claim.id,
			state: "succeeded",
			attempts: 1,
		});
		const [abandoned] = await context.database.orm
			.select()
			.from(deliveryAttempts)
			.where(eq(deliveryAttempts.id, claim.claimToken ?? ""));
		expect(abandoned).toMatchObject({
			sendStartedAt: null,
			error: "lease_expired_before_send",
		});
	} finally {
		sent.mockRestore();
	}
});

test("stale tokens cannot send, settle, or overwrite the replacement claim", async () => {
	const { worker, claim } = await queuedClaim();
	await context.database.orm
		.update(deliveries)
		.set({ leaseUntil: new Date(0) })
		.where(eq(deliveries.id, claim.id));
	const replacement = await probe(dispatcher()).claim(
		claim.id,
		claim.webhookId,
	);
	if (!replacement) throw new Error("Missing replacement claim");
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await probe(worker).send(claim);
		await probe(worker).settle(claim, { status: 204, error: null });
		expect(sent).not.toHaveBeenCalled();
		const [current] = await context.database.orm.select().from(deliveries);
		expect(current).toMatchObject({
			state: "claimed",
			claimToken: replacement.claimToken,
			attempts: 0,
		});
		await probe(dispatcher()).send(replacement);
		expect(sent).toHaveBeenCalledTimes(1);
	} finally {
		sent.mockRestore();
	}
});

test("an expired worker cannot settle even before another worker reclaims its token", async () => {
	const { worker, claim } = await queuedClaim();
	await context.database.orm
		.update(deliveries)
		.set({ leaseUntil: new Date(0) })
		.where(eq(deliveries.id, claim.id));
	await probe(worker).settle(claim, { status: 204, error: null });
	const [current] = await context.database.orm.select().from(deliveries);
	const [attempt] = await context.database.orm.select().from(deliveryAttempts);
	expect(current).toMatchObject({
		state: "claimed",
		claimToken: claim.claimToken,
	});
	expect(attempt?.completedAt).toBeNull();
});

test("settlement rechecks lease expiry after waiting for an unchanged locked row", async () => {
	const { worker, claim } = await queuedClaim();
	await context.database.orm
		.update(deliveries)
		.set({ leaseUntil: new Date(Date.now() + 1000) })
		.where(eq(deliveries.id, claim.id));
	const locked = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const holder = context.database.transaction(async (tx) => {
		await tx
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, claim.id))
			.for("update");
		locked.resolve();
		await release.promise;
	});
	await locked.promise;
	const settling = probe(worker).settle(claim, { status: 204, error: null });
	try {
		const deadline = Date.now() + 700;
		let waiting = false;
		while (Date.now() < deadline) {
			const [row] = await context.database.orm
				.select({
					waiting: sql<boolean>`exists(select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%webhook_deliveries%')`,
				})
				.from(sql`(values(1)) as fixture`);
			if (row?.waiting) {
				waiting = true;
				break;
			}
			await Bun.sleep(5);
		}
		expect(waiting).toBe(true);
		await Bun.sleep(1050);
		release.resolve();
		await Promise.all([holder, settling]);
		const [current] = await context.database.orm.select().from(deliveries);
		expect(current).toMatchObject({
			state: "claimed",
			claimToken: claim.claimToken,
			status: null,
		});
	} finally {
		release.resolve();
		await Promise.all([holder, settling]);
	}
});

test("send/settle crash recovery permits duplicates with stable delivery and event IDs", async () => {
	const hook = await endpoint();
	await event();
	const worker = dispatcher();
	const persist = spyOn(probe(worker), "settle").mockRejectedValue(
		new Error("Simulated lost settlement"),
	);
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await expect(worker.runOnce()).rejects.toThrow(
			"webhook endpoint operations failed",
		);
		const [uncertain] = await context.database.orm.select().from(deliveries);
		if (!uncertain) throw new Error("Missing uncertain delivery");
		expect(uncertain).toMatchObject({
			state: "claimed",
			attempts: 1,
			webhookId: hook.data.id,
		});
		persist.mockRestore();
		await context.database.orm
			.update(deliveries)
			.set({ leaseUntil: new Date(0) })
			.where(eq(deliveries.id, uncertain.id));
		await dispatcher().runOnce();
		const [delivered] = await context.database.orm.select().from(deliveries);
		expect(delivered).toMatchObject({
			id: uncertain.id,
			eventId: uncertain.eventId,
			state: "succeeded",
			attempts: 2,
		});
		expect(sent).toHaveBeenCalledTimes(2);
		expect(sent.mock.calls[0]?.[1]).toBe(sent.mock.calls[1]?.[1]);
		expect(
			sent.mock.calls.map((call) => call[2]["X-Keyzori-Delivery-Id"]),
		).toEqual([uncertain.id, uncertain.id]);
		const [abandoned] = await context.database.orm
			.select()
			.from(deliveryAttempts)
			.where(eq(deliveryAttempts.id, uncertain.claimToken ?? ""));
		expect(abandoned?.error).toBe("lease_expired_outcome_unknown");
	} finally {
		persist.mockRestore();
		sent.mockRestore();
	}
});

test("a send-marker persistence failure rolls back the budget and never reaches transport", async () => {
	await endpoint();
	await event();
	await context.database.orm.execute(
		sql`create function reject_webhook_send_marker() returns trigger language plpgsql as $$ begin if NEW.send_started_at is not null then raise exception 'Fixture send marker failure'; end if; return NEW; end; $$`,
	);
	await context.database.orm.execute(
		sql`create trigger reject_webhook_send_marker before update on webhook_delivery_attempts for each row execute function reject_webhook_send_marker()`,
	);
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await expect(dispatcher().runOnce()).rejects.toThrow(
			"webhook endpoint operations failed",
		);
		expect(sent).not.toHaveBeenCalled();
		const [unsent] = await context.database.orm.select().from(deliveries);
		const [attempt] = await context.database.orm
			.select()
			.from(deliveryAttempts);
		expect(unsent).toMatchObject({ state: "claimed", attempts: 0 });
		expect(attempt?.sendStartedAt).toBeNull();
	} finally {
		await context.database.orm.execute(
			sql`drop trigger reject_webhook_send_marker on webhook_delivery_attempts`,
		);
		await context.database.orm.execute(
			sql`drop function reject_webhook_send_marker()`,
		);
		sent.mockRestore();
	}
});

test("late network completion is fenced after lease reclamation", async () => {
	const { worker, claim } = await queuedClaim();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let requests = 0;
	const sent = spyOn(WebhookTransport.prototype, "send").mockImplementation(
		async () => {
			if (++requests === 1) {
				entered.resolve();
				await release.promise;
				return { status: 503, retryAfter: null };
			}
			return { status: 204, retryAfter: null };
		},
	);
	const first = probe(worker).send(claim);
	try {
		await entered.promise;
		await context.database.orm
			.update(deliveries)
			.set({ leaseUntil: new Date(0) })
			.where(eq(deliveries.id, claim.id));
		const replacement = await probe(dispatcher()).claim(
			claim.id,
			claim.webhookId,
		);
		if (!replacement) throw new Error("Missing replacement claim");
		await probe(dispatcher()).send(replacement);
		release.resolve();
		await first;
		const [current] = await context.database.orm.select().from(deliveries);
		expect(current).toMatchObject({
			state: "succeeded",
			attempts: 2,
			status: 204,
			error: null,
		});
	} finally {
		release.resolve();
		await first;
		sent.mockRestore();
	}
});

test("bad secrets and slow endpoints do not block healthy endpoint progress", async () => {
	const corrupt = await endpoint();
	const slow = await endpoint();
	const healthy = await endpoint();
	await context.database.orm
		.update(webhooks)
		.set({ secretCiphertext: "broken" })
		.where(eq(webhooks.id, corrupt.data.id));
	await event();
	const release = Promise.withResolvers<void>();
	const healthySent = Promise.withResolvers<void>();
	const slowEntered = Promise.withResolvers<void>();
	const sent = spyOn(WebhookTransport.prototype, "send").mockImplementation(
		async (_url, _body, headers) => {
			const [row] = await context.database.orm
				.select()
				.from(deliveries)
				.where(eq(deliveries.id, headers["X-Keyzori-Delivery-Id"] ?? ""));
			if (row?.webhookId === slow.data.id) {
				slowEntered.resolve();
				await release.promise;
			}
			if (row?.webhookId === healthy.data.id) healthySent.resolve();
			return { status: 204, retryAfter: null };
		},
	);
	const running = dispatcher().runOnce();
	const outcome = running.then(
		() => undefined,
		(error: unknown) => error,
	);
	try {
		await Promise.race([
			Promise.all([healthySent.promise, slowEntered.promise]),
			Bun.sleep(2000).then(() => {
				throw new Error("Healthy endpoint stalled behind another endpoint");
			}),
		]);
		expect(sent).toHaveBeenCalledTimes(2);
		release.resolve();
		expect(await outcome).toMatchObject({
			message: expect.stringContaining("webhook endpoint operations failed"),
		});
		const successful = await context.database.orm
			.select()
			.from(deliveries)
			.where(eq(deliveries.state, "succeeded"));
		expect(successful).toHaveLength(2);
	} finally {
		release.resolve();
		await outcome;
		sent.mockRestore();
	}
});

test("a full endpoint backlog stays bounded and does not consume its event cursor", async () => {
	const { hook, claim } = await queuedClaim();
	await context.database.orm
		.update(deliveries)
		.set({
			state: "pending",
			claimToken: null,
			leaseUntil: null,
			nextAttemptAt: new Date(Date.now() + 3600000),
		})
		.where(eq(deliveries.id, claim.id));
	await context.database.orm.insert(deliveries).values(
		Array.from({ length: 999 }, () => {
			const eventId = Bun.randomUUIDv7();
			return {
				...claim,
				id: Bun.randomUUIDv7(),
				eventId,
				payload: { ...claim.payload, id: eventId },
				state: "pending" as const,
				claimToken: null,
				leaseUntil: null,
				nextAttemptAt: new Date(Date.now() + 3600000),
			};
		}),
	);
	const [before] = await context.database.orm
		.select()
		.from(webhooks)
		.where(eq(webhooks.id, hook.data.id));
	await event();
	await dispatcher().runOnce();
	const [after] = await context.database.orm
		.select()
		.from(webhooks)
		.where(eq(webhooks.id, hook.data.id));
	expect(after?.lastSequence).toBe(before?.lastSequence);
	expect(after?.lastError).toBe("backlog_full");
	expect(
		await context.database.orm.select({ id: deliveries.id }).from(deliveries),
	).toHaveLength(1000);
});

test("manual replay uses new delivery identity while recovery preserves budget and rejects active claims", async () => {
	const { worker, claim } = await queuedClaim();
	const input = {
		ids: [claim.id],
		confirm: true as const,
		reason: "Operator recovery",
	};
	await expect(
		service.recover(input, context.operation()),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await context.database.orm
		.update(deliveries)
		.set({ leaseUntil: new Date(0) })
		.where(eq(deliveries.id, claim.id));
	const recovered = await service.recover(input, context.operation());
	expect(recovered.data[0]).toMatchObject({
		id: claim.id,
		attempts: 0,
		expiresAt: claim.expiresAt.toISOString(),
		state: "pending",
	});
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await worker.runOnce();
		const operation = context.operation();
		const replayed = await service.replay(input, operation);
		expect(replayed.data[0]).toMatchObject({
			replayOf: claim.id,
			eventId: claim.eventId,
			attempts: 0,
			state: "pending",
		});
		expect(replayed.data[0]?.id).not.toBe(claim.id);
		await expect(service.replay(input, operation)).rejects.toBeInstanceOf(
			Replay,
		);
		expect(await context.database.orm.select().from(deliveries)).toHaveLength(
			2,
		);
		await dispatcher().runOnce();
		expect(sent).toHaveBeenCalledTimes(2);
	} finally {
		sent.mockRestore();
	}
});

async function ownedEndpoint() {
	const groupId = Bun.randomUUIDv7();
	await context.database.orm.insert(groups).values({
		id: groupId,
		name: "Webhook authority",
		createdBy: "root",
		updatedBy: "root",
	});
	const key = await context.apiKeys.create(
		{ name: "Recovery owner" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [key.data.id],
			changes: {
				scopes: ["webhooks:*", "events:read", "licenses:read"],
				groupIds: [groupId],
			},
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [key.data.id] }, context.operation());
	const principal = await context.auth.authenticate(`Bearer ${key.credential}`);
	const operation = () => ({ ...context.operation(), principal });
	const hook = await service.create(
		{
			url: "https://receiver.example/",
			events: ["license.created"],
			groupIds: [groupId],
		},
		operation(),
	);
	await service.enable({ ids: [hook.data.id] }, operation());
	return { groupId, key, hook, operation };
}

test("manual replay rechecks exact ownership, current groups, event permissions and owner activity", async () => {
	const owned = await ownedEndpoint();
	await event(owned.groupId);
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await dispatcher().runOnce();
	} finally {
		sent.mockRestore();
	}
	const [delivery] = await context.database.orm.select().from(deliveries);
	if (!delivery) throw new Error("Missing delivery");
	const input = {
		ids: [delivery.id],
		confirm: true as const,
		reason: "Replay",
	};
	const unrelated = await ownedEndpoint();
	await expect(
		service.replay(input, unrelated.operation()),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await context.apiKeys.update(
		{
			ids: [owned.key.data.id],
			changes: { scopes: ["webhooks:read", "events:read", "licenses:read"] },
		},
		context.operation(),
	);
	await expect(service.replay(input, owned.operation())).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(service.recover(input, owned.operation())).rejects.toMatchObject(
		{ code: "FORBIDDEN" },
	);
	await context.apiKeys.update(
		{
			ids: [owned.key.data.id],
			changes: { scopes: ["webhooks:replay", "events:read"] },
		},
		context.operation(),
	);
	await expect(service.replay(input, owned.operation())).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	await context.apiKeys.update(
		{
			ids: [owned.key.data.id],
			changes: {
				scopes: ["webhooks:replay", "events:read", "licenses:read"],
				groupIds: [],
			},
		},
		context.operation(),
	);
	await expect(service.replay(input, owned.operation())).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	await expect(
		service.replay(input, context.operation()),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await context.apiKeys.disable(
		{ ids: [owned.key.data.id] },
		context.operation(),
	);
	await expect(
		service.replay(input, context.operation()),
	).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("deletion receipts survive resource removal but still require saved event and group authority", async () => {
	const owned = await ownedEndpoint();
	const operation = owned.operation();
	const input = {
		ids: [owned.hook.data.id],
		confirm: true as const,
		reason: "Retire endpoint",
	};
	await service.delete(input, operation);
	await expect(service.delete(input, operation)).rejects.toBeInstanceOf(Replay);
	await context.apiKeys.update(
		{
			ids: [owned.key.data.id],
			changes: { scopes: ["webhooks:delete", "events:read"] },
		},
		context.operation(),
	);
	await expect(service.delete(input, operation)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await context.apiKeys.update(
		{
			ids: [owned.key.data.id],
			changes: {
				scopes: ["webhooks:delete", "events:read", "licenses:read"],
				groupIds: [],
			},
		},
		context.operation(),
	);
	await expect(service.delete(input, operation)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
});

test("enqueue excludes counter events carrying inaccessible source-group or ungrouped history", async () => {
	const owned = await ownedEndpoint();
	const sourceGroupId = Bun.randomUUIDv7();
	await context.apiKeys.update(
		{
			ids: [owned.key.data.id],
			changes: {
				scopes: ["webhooks:*", "events:read", "licenses:read", "usage:read"],
			},
		},
		context.operation(),
	);
	await service.update(
		{ ids: [owned.hook.data.id], changes: { events: ["meter.updated"] } },
		owned.operation(),
	);
	await service.enable({ ids: [owned.hook.data.id] }, owned.operation());
	for (const authority of [
		{ requiredGroupIds: [sourceGroupId] },
		{ requiresAllGroups: true },
		{},
	]) {
		await context.database.transaction((tx) =>
			context.events.emit(
				tx,
				"meter.updated",
				{
					licenseId: Bun.randomUUIDv7(),
					groupId: owned.groupId,
					counterId: Bun.randomUUIDv7(),
					meter: "requests",
					definitionRevision: 2,
					resetGeneration: 0,
					periodId: "lifetime",
					periodStartedAt: null,
					periodEndsAt: null,
					value: "0",
					limit: "10",
				},
				new Date(),
				authority,
			),
		);
	}
	await activity.publish();
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await dispatcher().runOnce();
		expect(sent).toHaveBeenCalledTimes(1);
		expect(await context.database.orm.select().from(deliveries)).toHaveLength(
			1,
		);
		expect(sent.mock.calls[0]?.[1]).not.toContain("requiredGroupIds");
		expect(sent.mock.calls[0]?.[1]).not.toContain("requiresAllGroups");
	} finally {
		sent.mockRestore();
	}
});

test("claim/send, history and replay retain historical authorization after source-group revocation", async () => {
	const owned = await ownedEndpoint();
	const sourceGroupId = Bun.randomUUIDv7();
	await context.database.orm.insert(groups).values({
		id: sourceGroupId,
		name: "Source history",
		createdBy: "root",
		updatedBy: "root",
	});
	await context.apiKeys.update(
		{
			ids: [owned.key.data.id],
			changes: { groupIds: [owned.groupId, sourceGroupId] },
		},
		context.operation(),
	);
	await event(owned.groupId, { requiredGroupIds: [sourceGroupId] });
	await event(owned.groupId, { requiredGroupIds: [sourceGroupId] });
	const worker = dispatcher();
	await probe(worker).enqueue(owned.hook.data.id);
	const rows = await context.database.orm.select().from(deliveries);
	const first = rows[0];
	const second = rows[1];
	if (!first || !second) throw new Error("Missing protected deliveries");
	const claim = await probe(worker).claim(first.id, first.webhookId);
	if (!claim) throw new Error("Missing protected claim");
	await context.apiKeys.update(
		{ ids: [owned.key.data.id], changes: { groupIds: [owned.groupId] } },
		context.operation(),
	);
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	try {
		await probe(worker).send(claim);
		expect(
			await probe(worker).claim(second.id, second.webhookId),
		).toBeUndefined();
		expect(sent).not.toHaveBeenCalled();
		expect(
			(await context.database.orm.select().from(deliveries)).map(
				(row) => row.state,
			),
		).toEqual(["cancelled", "cancelled"]);
		const history = await service.deliveryHistory(
			new URLSearchParams({ webhookId: first.webhookId }),
			owned.operation(),
		);
		expect(history.data).toEqual([]);
		await expect(
			service.deliveryHistory(
				new URLSearchParams({ id: first.id }),
				owned.operation(),
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const input = {
			ids: [first.id],
			confirm: true as const,
			reason: "Replay retained history",
		};
		await expect(
			service.replay(input, owned.operation()),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			service.replay(input, context.operation()),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await context.apiKeys.update(
			{
				ids: [owned.key.data.id],
				changes: { groupIds: [owned.groupId, sourceGroupId] },
			},
			context.operation(),
		);
		const replay = await service.replay(input, owned.operation());
		const [copied] = await context.database.orm
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, replay.data[0]?.id ?? ""));
		expect(copied).toMatchObject({
			replayOf: first.id,
			eventId: first.eventId,
			requiredGroupIds: [sourceGroupId],
			requiresAllGroups: false,
		});
		expect(JSON.stringify(replay)).not.toContain("requiredGroupIds");
		await dispatcher().runOnce();
		expect(sent).toHaveBeenCalledTimes(1);
	} finally {
		sent.mockRestore();
	}
});

test("manual recovery cannot reset exhausted or expired budgets and requires an idempotency key", async () => {
	const { claim } = await queuedClaim();
	const input = { ids: [claim.id], confirm: true as const, reason: "Recover" };
	await expect(
		service.recover(input, {
			...context.operation(),
			idempotencyKey: undefined,
		}),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	await context.database.orm
		.update(deliveries)
		.set({ state: "pending", claimToken: null, leaseUntil: null, attempts: 8 })
		.where(eq(deliveries.id, claim.id));
	await expect(
		service.recover(input, context.operation()),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await context.database.orm
		.update(deliveries)
		.set({ attempts: 1, expiresAt: new Date(0) })
		.where(eq(deliveries.id, claim.id));
	await expect(
		service.recover(input, context.operation()),
	).rejects.toMatchObject({ code: "CONFLICT" });
	const [unchanged] = await context.database.orm.select().from(deliveries);
	expect(unchanged).toMatchObject({ attempts: 1, expiresAt: new Date(0) });
});

test("real TLS requests are cancelled by endpoint changes and dispatcher shutdown", async () => {
	for (const shutdown of [false, true]) {
		await context.database.orm.delete(deliveries);
		await context.database.orm.delete(webhooks);
		const hook = await endpoint();
		await event();
		const entered = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const fixture = await webhookTlsFixture((request) => {
			request.socket.once("close", () => closed.resolve());
			entered.resolve();
		});
		const realSend = WebhookTransport.prototype.send;
		const transport = fixture.transport();
		const sent = spyOn(WebhookTransport.prototype, "send").mockImplementation(
			(...args) => realSend.call(transport, ...args),
		);
		const worker = dispatcher();
		const running = worker.runOnce();
		try {
			await entered.promise;
			if (shutdown) worker.stop();
			else
				await service.update(
					{ ids: [hook.data.id], changes: { url: "https://new.example/" } },
					context.operation(),
				);
			await Promise.all([running, worker.drain()]);
			await Promise.race([
				closed.promise,
				Bun.sleep(1000).then(() => {
					throw new Error("Request was not cancelled");
				}),
			]);
			const [row] = await context.database.orm
				.select()
				.from(deliveries)
				.where(eq(deliveries.webhookId, hook.data.id));
			expect(row).toMatchObject({
				state: shutdown ? "pending" : "cancelled",
				attempts: 1,
				claimToken: null,
				leaseUntil: null,
			});
			if (shutdown) {
				expect(row?.error).toBe("shutdown_outcome_unknown");
				await worker.runOnce();
				expect(sent).toHaveBeenCalledTimes(1);
			} else {
				const [attempt] = await context.database.orm
					.select()
					.from(deliveryAttempts)
					.where(
						and(
							eq(deliveryAttempts.deliveryId, row?.id ?? ""),
							eq(deliveryAttempts.attempt, 1),
						),
					);
				expect(attempt?.error).toBe("endpoint_changed_outcome_unknown");
			}
		} finally {
			worker.stop();
			await running;
			sent.mockRestore();
			await fixture.close();
		}
	}
});

test("operator private-origin policy reaches management and real dispatch without permitting API retargeting", async () => {
	const received: { body: string; headers: Headers }[] = [];
	const receiver = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			received.push({ body: await request.text(), headers: request.headers });
			return new Response(null, { status: 204 });
		},
	});
	const privateDestinations = [
		{ origin: receiver.url.origin, cidrs: ["127.0.0.1/32"] },
	];
	const management = new WebhookService(
		context.database,
		context.auth,
		context.audit,
		context.settings,
		context.idempotency,
		{ encryptionKey, privateDestinations },
	);
	const worker = new WebhookDispatcher(
		context.database,
		context.settings,
		undefined,
		context.auth,
		encryptionKey,
		[],
		privateDestinations,
	);
	try {
		const hook = await management.create(
			{
				url: `${receiver.url.origin}/events`,
				events: ["license.created"],
				allGroups: true,
			},
			context.operation(),
		);
		await management.enable({ ids: [hook.data.id] }, context.operation());
		await expect(
			management.update(
				{
					ids: [hook.data.id],
					changes: { url: `http://127.0.0.2:${receiver.port}/events` },
				},
				context.operation(),
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await expect(
			service.create(
				{
					url: `${receiver.url.origin}/events`,
					events: ["license.created"],
					allGroups: true,
				},
				context.operation(),
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await event();
		await worker.runOnce();
		expect(received).toHaveLength(1);
		const request = received[0];
		if (!request) throw new Error("Missing private receiver request");
		const signature = createHmac("sha256", Buffer.from(hook.secret, "hex"))
			.update(
				`${request.headers.get("x-keyzori-timestamp")}.${request.headers.get("x-keyzori-delivery-id")}.${request.body}`,
			)
			.digest("hex");
		expect(request.headers.get("x-keyzori-signature")).toBe(`v1=${signature}`);
		const [delivery] = await context.database.orm.select().from(deliveries);
		expect(delivery).toMatchObject({
			webhookId: hook.data.id,
			state: "succeeded",
			attempts: 1,
		});
	} finally {
		worker.stop();
		await Promise.allSettled([worker.drain(), receiver.stop(true)]);
	}
});
