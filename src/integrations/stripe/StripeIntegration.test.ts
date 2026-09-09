import { describe, expect, mock, test } from "bun:test";
import type { Stripe } from "stripe";
import type {
	License,
	NewLicense,
	RevealedLicense,
	StripeSubscriptionLink,
	StripeWebhookEvent,
} from "../../domain/entities";
import { deriveLicenseStatus } from "../../domain/licenseStatus";
import type {
	ILicenseRepository,
	LicenseUpdate,
	LicenseWithAllowlists,
} from "../../domain/repositories/ILicenseRepository";
import type {
	IStripeSubscriptionRepository,
	IStripeWebhookRepository,
	NewStripeSubscriptionLink,
	NewStripeWebhookEvent,
	StripeSubscriptionLinkUpdate,
	StripeWebhookEnqueueResult,
} from "../../domain/repositories/IStripeRepository";
import type { ActivityRecorder } from "../../application/services/ActivityService";
import type {
	StripeGatewayPort,
	StripeSubscriptionSnapshot,
} from "./StripeGateway";
import {
	StripeIntegrationError,
	StripeSubscriptionService,
} from "./StripeSubscriptionService";
import {
	StripeWebhookService,
	subscriptionIdFromStripeEvent,
} from "./StripeWebhookService";
import { createStripeWebhookPlugin } from "./stripeWebhookPlugin";

const NOW = new Date("2026-08-15T00:00:00.000Z");
const PAID_THROUGH = new Date("2026-09-15T00:00:00.000Z");

function makeLicense(overrides: Partial<License> = {}): License {
	return {
		id: "lic-db-1",
		keyPrefix: "lic_123456789012",
		customerId: "customer-1",
		type: "subscription",
		maxIps: 2,
		maxDevices: 2,
		maxSessions: 2,
		sessionRevision: 0,
		trialDurationMinutes: 0,
		trialStartedAt: null,
		metadata: {},
		expiresAt: new Date("2026-08-20T00:00:00.000Z"),
		typeDrafts: {},
		manualRevokedAt: null,
		manualRevocationReason: null,
		billingRevokedAt: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function snapshot(
	overrides: Partial<StripeSubscriptionSnapshot> = {},
): StripeSubscriptionSnapshot {
	return {
		subscriptionId: "sub_1",
		stripeCustomerId: "cus_1",
		status: "active",
		paidThrough: PAID_THROUGH,
		cancelAtPeriodEnd: false,
		priceIds: ["price_1"],
		billingBlocked: false,
		...overrides,
	};
}

class MemoryStripeLinks implements IStripeSubscriptionRepository {
	readonly records = new Map<string, StripeSubscriptionLink>();
	licenses?: MemoryLicenses;
	private readonly reconciliationLocks = new Map<string, Promise<void>>();

	async withSubscriptionReconciliationLock<T>(
		subscriptionId: string,
		operation: (repository: IStripeSubscriptionRepository) => Promise<T>,
	): Promise<T> {
		const previous =
			this.reconciliationLocks.get(subscriptionId) ?? Promise.resolve();
		let release = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => current);
		this.reconciliationLocks.set(subscriptionId, tail);
		await previous;
		try {
			return await operation(this);
		} finally {
			release();
			if (this.reconciliationLocks.get(subscriptionId) === tail) {
				this.reconciliationLocks.delete(subscriptionId);
			}
		}
	}

	async createForSubscriptionLicense(
		data: NewStripeSubscriptionLink,
	): Promise<StripeSubscriptionLink | null> {
		const license = await this.licenses?.findById(data.licenseId);
		if (license && license.type !== "subscription") return null;
		if (
			[...this.records.values()].some(
				(link) =>
					link.licenseId === data.licenseId ||
					link.subscriptionId === data.subscriptionId,
			)
		) {
			throw new Error("unique violation");
		}
		const link: StripeSubscriptionLink = {
			id: crypto.randomUUID(),
			priceId: null,
			lastError: null,
			createdAt: NOW,
			updatedAt: NOW,
			...data,
		};
		this.records.set(link.subscriptionId, link);
		if (this.licenses && data.paidThrough) {
			await this.licenses.update(data.licenseId, {
				expiresAt: data.paidThrough,
			});
		}
		return link;
	}

	async findByLicenseId(
		licenseId: string,
	): Promise<StripeSubscriptionLink | null> {
		return (
			[...this.records.values()].find((link) => link.licenseId === licenseId) ??
			null
		);
	}

	async findBySubscriptionId(
		subscriptionId: string,
	): Promise<StripeSubscriptionLink | null> {
		return this.records.get(subscriptionId) ?? null;
	}

	async updateBySubscriptionId(
		subscriptionId: string,
		data: StripeSubscriptionLinkUpdate,
	): Promise<StripeSubscriptionLink> {
		const existing = this.records.get(subscriptionId);
		if (!existing) throw new Error("missing link");
		const updated = { ...existing, ...data, updatedAt: new Date() };
		this.records.set(subscriptionId, updated);
		return updated;
	}

	async reconcileForSubscriptionLicense(
		subscriptionId: string,
		data: StripeSubscriptionLinkUpdate,
	): Promise<StripeSubscriptionLink | null> {
		const existing = this.records.get(subscriptionId);
		if (!existing) return null;
		const license = await this.licenses?.findById(existing.licenseId);
		if (license && license.type !== "subscription") {
			this.records.delete(subscriptionId);
			return null;
		}
		const link = await this.updateBySubscriptionId(subscriptionId, data);
		if (this.licenses && data.paidThrough) {
			await this.licenses.update(existing.licenseId, {
				expiresAt: data.paidThrough,
			});
		}
		return link;
	}

	async setBillingRevocation(
		subscriptionId: string,
		billingRevokedAt: Date | null,
	): Promise<StripeSubscriptionLink> {
		return await this.updateBySubscriptionId(subscriptionId, {
			billingRevokedAt,
		});
	}

	async deleteByLicenseId(licenseId: string): Promise<boolean> {
		const link = await this.findByLicenseId(licenseId);
		if (!link) return false;
		this.records.delete(link.subscriptionId);
		return true;
	}
}

class MemoryLicenses implements ILicenseRepository {
	readonly records = new Map<string, License>();
	billingRevocationForLicense: (licenseId: string) => Date | null = () => null;

	constructor(...licenses: License[]) {
		for (const license of licenses) this.records.set(license.id, license);
	}

	async create(data: NewLicense): Promise<RevealedLicense> {
		const license = makeLicense({
			id: crypto.randomUUID(),
			customerId: data.customerId,
			type: data.type,
		});
		this.records.set(license.id, license);
		return { ...license, licenseKey: data.licenseKey };
	}

	async findById(id: string): Promise<License | null> {
		const license = this.records.get(id);
		return license
			? {
					...license,
					billingRevokedAt: this.billingRevocationForLicense(id),
				}
			: null;
	}

	async findByIdWithAllowlists(
		id: string,
	): Promise<LicenseWithAllowlists | null> {
		const license = await this.findById(id);
		return license ? { ...license, allowedIps: [], allowedDevices: [] } : null;
	}

	async findAll(): Promise<License[]> {
		const licenses: License[] = [];
		for (const id of this.records.keys()) {
			const license = await this.findById(id);
			if (license) licenses.push(license);
		}
		return licenses;
	}

	async update(id: string, data: LicenseUpdate): Promise<License> {
		const existing = this.records.get(id);
		if (!existing) throw new Error("missing license");
		this.records.set(id, { ...existing, ...data, updatedAt: new Date() });
		const updated = await this.findById(id);
		if (!updated) throw new Error("updated license missing");
		return updated;
	}

	async delete(id: string): Promise<void> {
		this.records.delete(id);
	}

	async findByLicenseKeyWithAllowlists(
		_licenseKey: string,
	): Promise<LicenseWithAllowlists | null> {
		return null;
	}

	async rotateKey(id: string, licenseKey: string): Promise<RevealedLicense> {
		const license = await this.update(id, {});
		return { ...license, licenseKey };
	}

	async incrementSessionRevision(id: string): Promise<License> {
		const license = await this.findById(id);
		if (!license) throw new Error("missing license");
		const updated = {
			...license,
			sessionRevision: license.sessionRevision + 1,
		};
		this.records.set(id, updated);
		return updated;
	}

	async updateWithSessionInvalidation(
		id: string,
		data: LicenseUpdate,
	): Promise<License> {
		const license = await this.update(id, data);
		license.sessionRevision++;
		return license;
	}

	async updateMeterDraft(id: string, meterNames: string[]): Promise<License> {
		const license = await this.findById(id);
		if (!license) throw new Error("missing license");
		return await this.update(id, {
			typeDrafts: {
				...license.typeDrafts,
				metered: { meterNames: [...meterNames].sort() },
			},
		});
	}

	async startTrialIfUnset(id: string, startedAt: Date): Promise<License> {
		return await this.update(id, { trialStartedAt: startedAt });
	}
}

class FakeStripeGateway implements StripeGatewayPort {
	current = snapshot();
	event = subscriptionEvent("evt_1", "customer.subscription.updated");
	getError: Error | null = null;
	verifyError: Error | null = null;
	getCalls = 0;
	verifiedPayload: Uint8Array | string | null = null;

	async verifyWebhook(
		payload: string | Uint8Array,
		_signature: string,
	): Promise<Stripe.Event> {
		this.verifiedPayload = payload;
		if (this.verifyError) throw this.verifyError;
		return this.event;
	}

	async getSubscription(
		_subscriptionId: string,
	): Promise<StripeSubscriptionSnapshot> {
		this.getCalls += 1;
		if (this.getError) throw this.getError;
		return this.current;
	}
}

function subscriptionEvent(id: string, type: string): Stripe.Event {
	return {
		id,
		object: "event",
		type,
		data: { object: { id: "sub_1", object: "subscription" } },
	} as Stripe.Event;
}

class MemoryWebhookEvents implements IStripeWebhookRepository {
	readonly records = new Map<string, StripeWebhookEvent>();

	async enqueue(
		data: NewStripeWebhookEvent,
	): Promise<StripeWebhookEnqueueResult> {
		const existing = this.records.get(data.eventId);
		if (existing) return { event: existing, inserted: false };
		const event: StripeWebhookEvent = {
			eventId: data.eventId,
			type: data.type,
			objectId: data.objectId ?? null,
			status: "pending",
			attempts: 0,
			nextAttemptAt: data.nextAttemptAt ?? NOW,
			payload: data.payload,
			lastError: null,
			receivedAt: NOW,
			processedAt: null,
		};
		this.records.set(event.eventId, event);
		return { event, inserted: true };
	}

	async claimDue(
		limit: number,
		now = new Date(),
	): Promise<StripeWebhookEvent[]> {
		const due = [...this.records.values()]
			.filter(
				(event) =>
					(event.status === "pending" || event.status === "failed") &&
					event.nextAttemptAt <= now,
			)
			.slice(0, limit);
		return due.map((event) => {
			const claimed: StripeWebhookEvent = {
				...event,
				status: "processing",
				attempts: event.attempts + 1,
				lastError: null,
			};
			this.records.set(event.eventId, claimed);
			return claimed;
		});
	}

	async markProcessed(
		eventId: string,
		processedAt = new Date(),
	): Promise<void> {
		const event = this.records.get(eventId);
		if (event) {
			this.records.set(eventId, {
				...event,
				status: "processed",
				processedAt,
				lastError: null,
			});
		}
	}

	async markFailed(
		eventId: string,
		error: string,
		nextAttemptAt: Date,
	): Promise<void> {
		const event = this.records.get(eventId);
		if (event) {
			this.records.set(eventId, {
				...event,
				status: "failed",
				lastError: error,
				nextAttemptAt,
			});
		}
	}

	async findById(eventId: string): Promise<StripeWebhookEvent | null> {
		return this.records.get(eventId) ?? null;
	}
}

function wireServices(license = makeLicense()) {
	const gateway = new FakeStripeGateway();
	const links = new MemoryStripeLinks();
	const licenses = new MemoryLicenses(license);
	links.licenses = licenses;
	licenses.billingRevocationForLicense = (licenseId) =>
		[...links.records.values()].find((link) => link.licenseId === licenseId)
			?.billingRevokedAt ?? null;
	const captured: Parameters<ActivityRecorder["capture"]>[0][] = [];
	const activity: ActivityRecorder = {
		capture: mock(async (event) => {
			captured.push(event);
			return null;
		}),
	};
	const subscriptions = new StripeSubscriptionService(
		gateway,
		licenses,
		links,
		activity,
	);
	return { gateway, links, licenses, activity, captured, subscriptions };
}

describe("StripeSubscriptionService", () => {
	test("links only subscription licenses and enforces unique links", async () => {
		const state = wireServices();
		const linked = await state.subscriptions.linkLicense(
			"lic-db-1",
			"sub_1",
			NOW,
		);
		expect(linked.link).toMatchObject({
			subscriptionId: "sub_1",
			stripeCustomerId: "cus_1",
			status: "active",
			paidThrough: PAID_THROUGH,
			priceId: "price_1",
			billingRevokedAt: null,
		});
		expect(linked.license.expiresAt).toEqual(PAID_THROUGH);
		expect(state.captured.at(-1)?.type).toBe("stripe.linked");
		expect(await state.subscriptions.getLink("lic-db-1")).toEqual(linked.link);
		expect(
			(await state.subscriptions.syncLicense("lic-db-1", NOW))?.link,
		).toMatchObject({ subscriptionId: "sub_1", status: "active" });
		expect(state.captured.at(-1)?.type).toBe("stripe.synchronized");

		state.licenses.records.set("lic-db-2", makeLicense({ id: "lic-db-2" }));
		await expect(
			state.subscriptions.linkLicense("lic-db-2", "sub_1", NOW),
		).rejects.toMatchObject({ code: "SUBSCRIPTION_ALREADY_LINKED" });

		const invalid = wireServices(makeLicense({ type: "lifetime" }));
		await expect(
			invalid.subscriptions.linkLicense("lic-db-1", "sub_1", NOW),
		).rejects.toBeInstanceOf(StripeIntegrationError);
		await expect(
			invalid.subscriptions.linkLicense("lic-db-1", "sub_1", NOW),
		).rejects.toMatchObject({ code: "LICENSE_TYPE_INVALID" });
	});

	test("unlinks locally without calling Stripe", async () => {
		const state = wireServices();
		await state.subscriptions.linkLicense("lic-db-1", "sub_1", NOW);
		const callsBeforeUnlink = state.gateway.getCalls;
		expect(await state.subscriptions.unlinkLicense("lic-db-1")).toBe(true);
		expect(await state.links.findByLicenseId("lic-db-1")).toBeNull();
		expect(state.gateway.getCalls).toBe(callsBeforeUnlink);
		expect(state.captured.at(-1)?.type).toBe("stripe.unlinked");
	});

	test("serializes initial linking with webhook reconciliation", async () => {
		const state = wireServices();
		let fetchCalls = 0;
		let releaseLinkFetch = () => {};
		let markLinkFetchStarted = () => {};
		const linkFetchStarted = new Promise<void>((resolve) => {
			markLinkFetchStarted = resolve;
		});
		const linkFetchRelease = new Promise<void>((resolve) => {
			releaseLinkFetch = resolve;
		});
		state.gateway.getSubscription = mock(async () => {
			fetchCalls += 1;
			const call = fetchCalls;
			if (call === 1) {
				markLinkFetchStarted();
				await linkFetchRelease;
				return snapshot();
			}
			return snapshot({
				status: "canceled",
				paidThrough: null,
				billingBlocked: true,
			});
		});

		const linking = state.subscriptions.linkLicense("lic-db-1", "sub_1", NOW);
		await linkFetchStarted;
		const reconciling = state.subscriptions.reconcileSubscription(
			"sub_1",
			new Date(NOW.getTime() + 1_000),
		);
		await Bun.sleep(0);
		expect(fetchCalls).toBe(1);
		releaseLinkFetch();
		await Promise.all([linking, reconciling]);

		expect(await state.links.findBySubscriptionId("sub_1")).toMatchObject({
			status: "canceled",
			paidThrough: null,
			billingRevokedAt: new Date(NOW.getTime() + 1_000),
		});
	});

	test("billing failure and recovery never clear a manual revocation", async () => {
		const manualRevokedAt = new Date("2026-08-01T00:00:00.000Z");
		const state = wireServices(
			makeLicense({
				manualRevokedAt,
				manualRevocationReason: "operator decision",
			}),
		);
		await state.subscriptions.linkLicense("lic-db-1", "sub_1", NOW);

		state.gateway.current = snapshot({
			status: "canceled",
			paidThrough: null,
			billingBlocked: true,
		});
		const blocked = await state.subscriptions.reconcileSubscription(
			"sub_1",
			NOW,
		);
		expect(blocked?.link.billingRevokedAt).toEqual(NOW);
		expect(blocked?.link.paidThrough).toBeNull();
		expect(blocked?.license.expiresAt).toEqual(PAID_THROUGH);
		expect(blocked?.license.manualRevokedAt).toEqual(manualRevokedAt);
		if (!blocked) throw new Error("Expected blocked reconciliation result.");
		expect(deriveLicenseStatus(blocked.license, NOW)).toEqual({
			status: "revoked",
			reason: "manual_revocation",
		});

		state.gateway.current = snapshot({
			status: "active",
			billingBlocked: false,
		});
		const recovered = await state.subscriptions.reconcileSubscription(
			"sub_1",
			new Date(NOW.getTime() + 1_000),
		);
		expect(recovered?.link.billingRevokedAt).toBeNull();
		expect(recovered?.license.manualRevokedAt).toEqual(manualRevokedAt);
		if (!recovered)
			throw new Error("Expected recovered reconciliation result.");
		expect(deriveLicenseStatus(recovered.license, NOW).reason).toBe(
			"manual_revocation",
		);
	});

	test("serializes subscription fetch and write across concurrent reconciliations", async () => {
		const state = wireServices();
		await state.subscriptions.linkLicense("lic-db-1", "sub_1", NOW);
		let fetchCalls = 0;
		let activeFetches = 0;
		let maximumActiveFetches = 0;
		let releaseFirst = () => {};
		let markFirstEntered = () => {};
		const firstEntered = new Promise<void>((resolve) => {
			markFirstEntered = resolve;
		});
		const firstRelease = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		state.gateway.getSubscription = mock(async () => {
			fetchCalls += 1;
			const call = fetchCalls;
			activeFetches += 1;
			maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
			if (call === 1) {
				markFirstEntered();
				await firstRelease;
			}
			activeFetches -= 1;
			return call === 1
				? snapshot({
						status: "canceled",
						paidThrough: null,
						billingBlocked: true,
					})
				: snapshot({
						status: "active",
						paidThrough: new Date("2026-10-15T00:00:00.000Z"),
						billingBlocked: false,
					});
		});

		const older = state.subscriptions.reconcileSubscription(
			"sub_1",
			new Date(NOW.getTime() + 1_000),
		);
		await firstEntered;
		const newer = state.subscriptions.reconcileSubscription(
			"sub_1",
			new Date(NOW.getTime() + 2_000),
		);
		await Bun.sleep(0);
		expect(fetchCalls).toBe(1);
		releaseFirst();
		await Promise.all([older, newer]);

		expect(maximumActiveFetches).toBe(1);
		expect(await state.links.findBySubscriptionId("sub_1")).toMatchObject({
			status: "active",
			paidThrough: new Date("2026-10-15T00:00:00.000Z"),
			billingRevokedAt: null,
		});
	});
});

describe("Stripe webhook inbox", () => {
	test("derives subscription IDs from subscription and Dahlia invoice events", () => {
		expect(
			subscriptionIdFromStripeEvent(
				subscriptionEvent("evt_sub", "customer.subscription.updated"),
			),
		).toBe("sub_1");
		const invoice = {
			id: "evt_invoice",
			object: "event",
			type: "invoice.paid",
			data: {
				object: {
					id: "in_1",
					object: "invoice",
					parent: {
						type: "subscription_details",
						subscription_details: { subscription: "sub_invoice" },
					},
				},
			},
		} as unknown as Stripe.Event;
		expect(subscriptionIdFromStripeEvent(invoice)).toBe("sub_invoice");
	});

	test("enqueues signed events once and reconciles current state, not event order", async () => {
		const state = wireServices();
		await state.subscriptions.linkLicense("lic-db-1", "sub_1", NOW);
		state.gateway.current = snapshot({
			status: "active",
			billingBlocked: false,
		});
		state.gateway.event = subscriptionEvent(
			"evt_old_canceled",
			"customer.subscription.deleted",
		);
		const events = new MemoryWebhookEvents();
		const webhooks = new StripeWebhookService(
			state.gateway,
			events,
			state.subscriptions,
			state.activity,
		);

		expect((await webhooks.receive("old payload", "sig")).inserted).toBe(true);
		expect((await webhooks.receive("old payload", "sig")).inserted).toBe(false);
		const before = state.gateway.getCalls;
		expect(await webhooks.processDue(10, NOW)).toEqual({
			claimed: 1,
			processed: 1,
			failed: 0,
		});
		expect(state.gateway.getCalls).toBe(before + 1);
		expect((await state.links.findBySubscriptionId("sub_1"))?.status).toBe(
			"active",
		);
		expect((await events.findById("evt_old_canceled"))?.status).toBe(
			"processed",
		);
	});

	test("retries failures with capped exponential backoff", async () => {
		const state = wireServices();
		await state.subscriptions.linkLicense("lic-db-1", "sub_1", NOW);
		state.gateway.getError = new Error("temporary Stripe outage");
		const events = new MemoryWebhookEvents();
		const webhooks = new StripeWebhookService(
			state.gateway,
			events,
			state.subscriptions,
			state.activity,
			{ baseDelayMs: 100, maxDelayMs: 250 },
		);
		await webhooks.receive("payload", "sig");

		await webhooks.processDue(1, NOW);
		expect((await events.findById("evt_1"))?.nextAttemptAt).toEqual(
			new Date(NOW.getTime() + 100),
		);
		await webhooks.processDue(1, new Date(NOW.getTime() + 100));
		expect((await events.findById("evt_1"))?.nextAttemptAt).toEqual(
			new Date(NOW.getTime() + 300),
		);
		await webhooks.processDue(1, new Date(NOW.getTime() + 300));
		expect((await events.findById("evt_1"))?.nextAttemptAt).toEqual(
			new Date(NOW.getTime() + 550),
		);

		state.gateway.getError = null;
		expect(
			await webhooks.processDue(1, new Date(NOW.getTime() + 550)),
		).toMatchObject({ processed: 1, failed: 0 });
		expect((await events.findById("evt_1"))?.status).toBe("processed");
		expect(
			(await state.links.findBySubscriptionId("sub_1"))?.lastError,
		).toBeNull();
	});

	test("plugin passes untouched bytes and reports durable duplicates", async () => {
		const state = wireServices();
		const events = new MemoryWebhookEvents();
		const webhooks = new StripeWebhookService(
			state.gateway,
			events,
			state.subscriptions,
		);
		const wake = mock(() => undefined);
		const app = createStripeWebhookPlugin(webhooks, {
			onWorkAvailable: wake,
		});
		const raw = '{  "intentionally": "spaced"  }';
		const request = () =>
			new Request("http://localhost/webhooks/stripe", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"stripe-signature": "signed",
				},
				body: raw,
			});

		const first = await app.handle(request());
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			received: true,
			duplicate: false,
		});
		expect(
			new TextDecoder().decode(state.gateway.verifiedPayload as Uint8Array),
		).toBe(raw);
		const duplicate = await app.handle(request());
		expect(await duplicate.json()).toMatchObject({ duplicate: true });
		expect(wake).toHaveBeenCalledTimes(2);
	});
});
