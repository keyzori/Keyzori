import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../../core/database/Database";
import type { AuthService } from "../../core/auth/AuthService";
import type { Redis } from "../../core/redis/Redis";
import { activityEvents, eventState } from "../../core/database/schema/events";
import { audits } from "../../core/database/schema/audits";
import { webhooks } from "../../core/database/schema/webhooks";
import { HttpError } from "../../core/http/HttpError";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import type { $Principal } from "../../types/auth";
import type { $Operation } from "../../types/operation";
import {
	allowedEvents,
	historicalGroupFilter,
} from "../../core/auth/EventAuthorization";
import { readEventEnvelope } from "../webhooks/events";
import type { $PublishedEvent } from "../../types/webhooks";
import { activityOptions, type ActivityOptions } from "./options";
import { Check } from "typebox/value";
import { activitySubscribeSchema } from "./model";
import { resetEventEpoch } from "./EventEpoch";
import type { Metrics } from "../../core/observability/Metrics";
import { transportBufferedBytes } from "./SocketQueue";

type Socket = {
	id: string;
	/** Elysia's native socket, when exposed; queue sampling is capability-checked. */
	raw?: unknown;
	send(value: unknown): number;
	close(code?: number, reason?: string): void;
};
type Session = {
	socket: Socket;
	principal: $Principal;
	ip: string;
	cursor?: string;
	timer?: ReturnType<typeof setTimeout>;
	watchdog?: ReturnType<typeof setTimeout>;
	leaseWatchdog?: ReturnType<typeof setTimeout>;
	subscribed: boolean;
	admission?: Promise<void>;
	leasedAt: number;
	expiresAt: number;
	stopped: boolean;
	queuedFrames: number;
	queuedBytes: number;
};

export class ActivityService {
	private readonly sessions = new Map<string, Session>();
	private readonly options;
	private stopped = false;
	constructor(
		private readonly database: Pick<Database, "transaction">,
		private readonly auth: AuthService,
		private readonly redis: Pick<Redis, "send">,
		readonly origins: string[] = [],
		private readonly maxStreams = 100,
		options: ActivityOptions = {},
		private readonly metrics?: Pick<Metrics, "setGauge">,
	) {
		this.options = activityOptions(options);
		if (!Number.isSafeInteger(maxStreams) || maxStreams < 1)
			throw new Error("Invalid activity stream limit");
		this.updateGauges();
	}

	/** Short serialized publication; never includes domain mutations or network sends. */
	async publish(limit = 100) {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
			throw new RangeError("Invalid publication batch limit");
		return this.database.transaction(async (tx) => {
			await tx
				.insert(eventState)
				.values({ id: 1, epoch: Bun.randomUUIDv7() })
				.onConflictDoNothing();
			const [state] = await tx
				.select()
				.from(eventState)
				.where(eq(eventState.id, 1))
				.for("update");
			if (!state) throw new Error("Event state unavailable");
			const pending = await tx
				.select({ id: activityEvents.id })
				.from(activityEvents)
				.where(isNull(activityEvents.sequence))
				.orderBy(asc(activityEvents.ordinal))
				.limit(limit);
			const [clock] = await tx
				.select({ now: sql<Date>`clock_timestamp()` })
				.from(sql`(values (1)) as clock`);
			if (!clock) throw new Error("Database time unavailable");
			let sequence = state.sequence;
			for (const event of pending)
				await tx
					.update(activityEvents)
					.set({ sequence: ++sequence, publishedAt: clock.now })
					.where(eq(activityEvents.id, event.id));
			if (pending.length)
				await tx
					.update(eventState)
					.set({ sequence })
					.where(eq(eventState.id, 1));
			return pending.length;
		});
	}

	/**
	 * Capture BEFORE listing resources, then replay from this cursor. Independent
	 * list pages are non-atomic; this is not a database snapshot/export protocol.
	 * Events are invalidations: re-read their authorized subjects, deduplicate by id,
	 * and keep the highest processed resource.revision. Serialize each subject's
	 * refetches (or discard stale completions). Never overwrite current state with a
	 * historical payload. Save a cursor only after its invalidations are processed.
	 * A 410 (retention, grants or epoch change) restarts this flow.
	 */
	async watermark(operation: $Operation) {
		return this.database.transaction(
			async (tx) => {
				const principal = await this.auth.authorize(
					tx,
					operation.principal,
					"events:read",
				);
				const [state] = await tx
					.select()
					.from(eventState)
					.where(eq(eventState.id, 1))
					.for("share");
				if (!state) throw new HttpError("SERVICE_UNAVAILABLE");
				return {
					data: {
						protocol: "invalidation-refetch" as const,
						stateConsistency: "non-atomic" as const,
						epoch: state.epoch,
						sequence: String(state.sequence),
						retainedAfter: String(state.retainedAfter),
						cursor: this.encode(
							state.epoch,
							state.sequence,
							this.binding(principal),
						),
					},
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	/** Privileged operational gauges; no event payloads or resource identifiers. */
	async backlog(deadlineAt = Date.now() + 5000) {
		const result = await this.database.transaction(
			async (tx) => {
				const [backlog] = await tx
					.select({
						unpublished: sql<number>`count(*)::float8`,
						publicationLagSeconds: sql<number>`greatest(0, extract(epoch from (clock_timestamp() - min(${activityEvents.createdAt}))))::float8`,
					})
					.from(activityEvents)
					.where(isNull(activityEvents.sequence));
				if (!backlog) throw new Error("Event backlog unavailable");
				return backlog;
			},
			"read",
			deadlineAt,
		);
		const queue = this.queueStats();
		let measuredBytes: number | undefined = 0;
		for (const session of this.sessions.values()) {
			const bytes = transportBufferedBytes(session.socket);
			if (bytes === undefined || !Number.isSafeInteger(measuredBytes + bytes)) {
				measuredBytes = undefined;
				break;
			}
			measuredBytes += bytes;
		}
		return {
			...result,
			activeStreams: this.sessions.size,
			queueMessages: queue.messages,
			queueBytes: queue.bytes,
			...(measuredBytes === undefined
				? {}
				: { transportBufferedBytes: measuredBytes }),
		};
	}

	/** Operator-only restore hook; main owns CLI authorization and service quiescing. */
	async resetEpoch() {
		const state = await this.database.transaction(resetEventEpoch, "write");
		// Other replicas detect the epoch mismatch on their next read. Published
		// sequences are never rebased: webhook enqueue positions stay meaningful.
		for (const id of this.sessions.keys())
			this.close(id, 1012, "Stream epoch changed; resynchronize");
		return state;
	}

	/** Delete only a contiguous published prefix already passed by every active webhook. */
	async prune(options: {
		retentionMs: number;
		limit?: number;
		deadlineAt?: number;
	}) {
		const limit = options.limit ?? 100;
		if (
			!Number.isSafeInteger(options.retentionMs) ||
			options.retentionMs < 1 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 1000
		)
			throw new RangeError("Invalid activity retention budget");
		return this.database.transaction(
			async (tx) => {
				const [state] = await tx
					.select()
					.from(eventState)
					.where(eq(eventState.id, 1))
					.for("update");
				if (!state) throw new HttpError("SERVICE_UNAVAILABLE");
				const [checkpoint] = await tx
					.select({
						sequence: sql<string | null>`min(${webhooks.lastSequence})::text`,
					})
					.from(webhooks)
					.where(eq(webhooks.enabled, true));
				const safeSequence =
					checkpoint?.sequence == null
						? state.sequence
						: BigInt(checkpoint.sequence);
				const [clock] = await tx
					.select({ now: sql<Date>`clock_timestamp()` })
					.from(sql`(values (1)) as clock`);
				if (!clock) throw new Error("Database time unavailable");
				const before = clock.now.getTime() - options.retentionMs;
				const candidates = await tx
					.select({
						id: activityEvents.id,
						sequence: activityEvents.sequence,
						publishedAt: activityEvents.publishedAt,
					})
					.from(activityEvents)
					.where(
						and(
							gt(activityEvents.sequence, state.retainedAfter),
							lte(activityEvents.sequence, safeSequence),
						),
					)
					.orderBy(asc(activityEvents.sequence))
					.limit(limit);
				const ids: string[] = [];
				let retainedAfter = state.retainedAfter;
				for (const candidate of candidates) {
					if (
						!candidate.sequence ||
						!candidate.publishedAt ||
						candidate.publishedAt.getTime() >= before
					)
						break;
					ids.push(candidate.id);
					retainedAfter = candidate.sequence;
				}
				if (ids.length) {
					await tx
						.delete(activityEvents)
						.where(inArray(activityEvents.id, ids));
					await tx
						.update(eventState)
						.set({ retainedAfter })
						.where(eq(eventState.id, 1));
				}
				return { removed: ids.length, retainedAfter: String(retainedAfter) };
				// Coordinate endpoint enable/disable and enqueue with the same topology lock.
			},
			"write",
			options.deadlineAt ?? Date.now() + 5000,
		);
	}

	allowedEvents(principal: $Principal) {
		return allowedEvents(this.auth, principal);
	}

	async read(
		params: URLSearchParams,
		operation: $Operation,
		subscription = false,
	) {
		for (const key of params.keys())
			if (!["cursor", "limit"].includes(key) || params.getAll(key).length !== 1)
				throw new HttpError("INVALID_REQUEST");
		const limitText = params.get("limit") ?? "50";
		if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > 100)
			throw new HttpError("INVALID_REQUEST");
		const limit = Number(limitText);
		return this.database.transaction(
			async (tx) => {
				const principal = await this.auth.authorize(
					tx,
					operation.principal,
					subscription ? "events:subscribe" : "events:read",
				);
				const [state] = await tx
					.select()
					.from(eventState)
					.where(eq(eventState.id, 1))
					.for("share");
				if (!state) throw new HttpError("SERVICE_UNAVAILABLE");
				const binding = this.binding(principal);
				const after = params.has("cursor")
					? this.decode(params.get("cursor") ?? "", state.epoch, binding)
					: 0n;
				if (after > state.sequence || after < state.retainedAfter)
					throw new HttpError("CURSOR_EXPIRED");
				const rows = await tx
					.select()
					.from(activityEvents)
					.where(
						and(
							gt(activityEvents.sequence, after),
							lte(activityEvents.sequence, state.sequence),
							inArray(activityEvents.event, this.allowedEvents(principal)),
							this.auth.groupFilter(principal, activityEvents.groupId),
							historicalGroupFilter(principal, activityEvents),
							principal.kind === "api" && !principal.allGroups
								? eq(activityEvents.global, false)
								: undefined,
						),
					)
					.orderBy(asc(activityEvents.sequence))
					.limit(limit + 1);
				const data: $PublishedEvent[] = [];
				let bytes = 1024; // Cursor and protocol framing reserve.
				for (const row of rows.slice(0, limit)) {
					const payload = readEventEnvelope(row.payload);
					if (
						payload.id !== row.id ||
						payload.event !== row.event ||
						("groupId" in payload.data ? payload.data.groupId : null) !==
							row.groupId ||
						payload.resource.type !== row.resourceType ||
						payload.resource.id !== row.resourceId ||
						payload.resource.revision !== String(row.resourceRevision)
					)
						throw new Error("Inconsistent persisted event");
					const event = {
						...payload,
						sequence: String(row.sequence),
						epoch: state.epoch,
					};
					const size = Buffer.byteLength(JSON.stringify(event)) + 1;
					if (size > 33792)
						throw new Error("Persisted event exceeds payload budget");
					if (bytes + size > this.options.batchBytes) break;
					bytes += size;
					data.push(event);
				}
				const hasMore = rows.length > data.length;
				const sequence = hasMore
					? BigInt(data.at(-1)?.sequence ?? after)
					: state.sequence;
				return {
					data,
					pageLimit: limit,
					cursor: this.encode(state.epoch, sequence, binding),
					hasMore,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	async history(params: URLSearchParams, operation: $Operation) {
		return this.database.transaction(
			async (tx) => {
				const principal = await this.auth.authorize(
					tx,
					operation.principal,
					"audits:read",
				);
				const query = new ResourceQuery(
					params,
					{
						id: audits.id,
						createdAt: audits.createdAt,
						updatedAt: audits.createdAt,
					},
					50,
				);
				const rows = await tx
					.select()
					.from(audits)
					.where(
						and(
							query.where,
							this.auth.groupFilter(principal, audits.groupId),
							principal.kind === "api" && !principal.allGroups
								? eq(audits.global, false)
								: undefined,
							historicalGroupFilter(principal, audits),
						),
					)
					.orderBy(...query.order)
					.limit(query.limit + 1);
				const data = rows.slice(0, query.limit);
				const last = data.at(-1);
				return {
					data: data.map((row) => ({
						...row,
						createdAt: row.createdAt.toISOString(),
					})),
					pageLimit: query.limit,
					nextCursor:
						rows.length > query.limit && last
							? query.cursor({ ...last, updatedAt: last.createdAt })
							: null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	assertOrigin(request: Request) {
		const origin = request.headers.get("origin");
		if (origin && !this.origins.includes(origin))
			throw new HttpError("FORBIDDEN");
		if (new URL(request.url).search) throw new HttpError("INVALID_REQUEST");
	}

	async open(socket: Socket, operation: $Operation) {
		if (this.stopped || this.sessions.size >= this.maxStreams) {
			socket.close(1013, "Connection limit");
			return;
		}
		const session: Session = {
			socket,
			principal: operation.principal,
			ip: operation.clientIp,
			leasedAt: 0,
			expiresAt: Date.now() + this.options.sessionLifetimeMs,
			subscribed: false,
			stopped: false,
			queuedFrames: 0,
			queuedBytes: 0,
		};
		this.sessions.set(socket.id, session);
		this.updateGauges();
		session.watchdog = setTimeout(
			() => this.close(socket.id, 1008, "Subscribe deadline expired"),
			this.options.subscribeTimeoutMs,
		);
		session.admission = this.lease(session);
		try {
			await session.admission;
			if (session.stopped) return;
			if (
				this.send(session, {
					type: "ready",
					schemaVersion: 1,
					protocol: "invalidation-refetch",
					stateConsistency: "non-atomic",
					resync: "/events/watermark",
					sessionExpiresAt: new Date(session.expiresAt).toISOString(),
				}) <= 0
			)
				this.close(socket.id, 1013, "Slow consumer");
		} catch {
			this.close(socket.id, 1013, "Admission unavailable");
		}
	}

	async message(id: string, value: unknown) {
		if (!Check(activitySubscribeSchema, value)) {
			this.close(id, 1008, "Invalid subscription message");
			return;
		}
		await this.subscribe(id, value.cursor);
	}

	async subscribe(id: string, cursor?: string) {
		const session = this.sessions.get(id);
		if (!session || session.stopped) return;
		if (session.subscribed) {
			this.close(id, 1008, "Already subscribed");
			return;
		}
		session.subscribed = true;
		try {
			await session.admission;
		} catch {
			this.close(id, 1013, "Admission unavailable");
			return;
		}
		if (session.stopped) return;
		clearTimeout(session.watchdog);
		session.cursor = cursor;
		await this.pump(session);
	}

	close(id: string, code = 1000, reason = "Closed") {
		const session = this.sessions.get(id);
		if (!session) return;
		session.stopped = true;
		clearTimeout(session.timer);
		clearTimeout(session.watchdog);
		clearTimeout(session.leaseWatchdog);
		this.sessions.delete(id);
		session.queuedFrames = 0;
		session.queuedBytes = 0;
		this.updateGauges();
		session.socket.close(code, reason);
		void this.releaseLease(session).catch(() => undefined);
	}
	stop() {
		this.stopped = true;
		for (const id of this.sessions.keys())
			this.close(id, 1012, "Server restarting; reconnect with cursor");
	}

	private async pump(session: Session) {
		try {
			if (session.stopped) return;
			if (
				Date.now() >= session.expiresAt ||
				Date.now() - session.leasedAt >=
					this.options.leaseMs - this.options.leaseSafetyMs
			) {
				this.close(session.socket.id, 1008, "Session expired");
				return;
			}
			if (Date.now() - session.leasedAt >= this.options.renewEveryMs)
				await this.lease(session);
			if (session.stopped) return;
			const params = new URLSearchParams({ limit: "100" });
			if (session.cursor) params.set("cursor", session.cursor);
			const result = await this.read(
				params,
				{
					principal: session.principal,
					requestId: Bun.randomUUIDv7(),
					clientIp: session.ip,
					deadlineAt: Date.now() + 5000,
				},
				true,
			);
			if (
				session.stopped ||
				Date.now() >= session.expiresAt ||
				Date.now() - session.leasedAt >=
					this.options.leaseMs - this.options.leaseSafetyMs
			) {
				this.close(session.socket.id, 1013, "Lease expired");
				return;
			}
			const bytes = JSON.stringify({
				type: "events",
				data: result.data,
				cursor: result.cursor,
				hasMore: result.hasMore,
			});
			if (Buffer.byteLength(bytes) > 262144 || this.send(session, bytes) <= 0) {
				this.close(
					session.socket.id,
					1013,
					"Slow consumer; reconnect with processed cursor",
				);
				return;
			}
			session.cursor = result.cursor;
			session.timer = setTimeout(
				() => {
					void this.pump(session);
				},
				result.hasMore
					? this.options.replayIntervalMs
					: this.options.pollIntervalMs,
			);
		} catch (error) {
			if (!session.stopped && error instanceof HttpError)
				this.send(session, {
					type: "error",
					code: error.code,
					...(error.code === "CURSOR_EXPIRED"
						? { resync: "/events/watermark" }
						: {}),
				});
			this.close(
				session.socket.id,
				1008,
				"Authorization or dependency unavailable; reconnect",
			);
		}
	}

	/** These gauges count serialized application frames, not events or kernel buffers. */
	private queueStats() {
		let messages = 0;
		let bytes = 0;
		for (const session of this.sessions.values()) {
			messages += session.queuedFrames;
			bytes += session.queuedBytes;
		}
		return { messages, bytes };
	}

	private updateGauges() {
		if (!this.metrics) return;
		const queue = this.queueStats();
		this.metrics.setGauge("keyzori_streams_active", this.sessions.size);
		this.metrics.setGauge("keyzori_stream_queue_messages", queue.messages);
		this.metrics.setGauge("keyzori_stream_queue_bytes", queue.bytes);
	}

	private send(session: Session, value: unknown) {
		if (session.stopped) return 0;
		const frame = typeof value === "string" ? value : JSON.stringify(value);
		session.queuedFrames = 1;
		session.queuedBytes = Buffer.byteLength(frame);
		this.updateGauges();
		try {
			const status = session.socket.send(frame);
			if (status > 0) {
				session.queuedFrames = 0;
				session.queuedBytes = 0;
			}
			// A backpressured frame remains tracked until the caller closes; it is
			// never added to an unbounded retry queue or silently reported as drained.
			return status;
		} catch {
			return 0;
		} finally {
			this.updateGauges();
		}
	}
	private leaseKeys(session: Session) {
		const hash = new Bun.CryptoHasher("sha256")
			.update(session.ip)
			.digest("hex");
		return [
			`kz:streams:principal:${session.principal.id}`,
			`kz:streams:ip:${hash}`,
		];
	}
	private async releaseLease(session: Session) {
		await this.redis.send("EVAL", [
			"redis.call('ZREM',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1]); return 1",
			"2",
			...this.leaseKeys(session),
			session.socket.id,
		]);
	}
	private async lease(session: Session) {
		if (session.stopped) return;
		const started = Date.now();
		const result = await this.redis.send("EVAL", [
			"local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); for i=1,2 do redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now); local member=redis.call('ZSCORE',KEYS[i],ARGV[1]); if ARGV[5]=='1' and not member then return 0 end; if not member and redis.call('ZCARD',KEYS[i]) >= tonumber(ARGV[i+1]) then return 0 end end; for i=1,2 do redis.call('ZADD',KEYS[i],now+tonumber(ARGV[4]),ARGV[1]); redis.call('PEXPIRE',KEYS[i],ARGV[4]) end; return 1",
			"2",
			...this.leaseKeys(session),
			session.socket.id,
			"5",
			"20",
			String(this.options.leaseMs),
			session.leasedAt ? "1" : "0",
		]);
		if (result !== 1) throw new HttpError("SERVICE_UNAVAILABLE");
		if (session.stopped) {
			await this.releaseLease(session);
			return;
		}
		session.leasedAt = started;
		clearTimeout(session.leaseWatchdog);
		const remaining = Math.min(
			session.expiresAt - Date.now(),
			started + this.options.leaseMs - this.options.leaseSafetyMs - Date.now(),
		);
		if (remaining <= 0) throw new HttpError("SERVICE_UNAVAILABLE");
		session.leaseWatchdog = setTimeout(
			() => this.close(session.socket.id, 1008, "Session or lease expired"),
			remaining,
		);
	}
	private binding(principal: $Principal) {
		return new Bun.CryptoHasher("sha256")
			.update(
				JSON.stringify(
					principal.kind === "root"
						? ["root"]
						: [
								principal.id,
								principal.scopes.slice().sort(),
								principal.allGroups,
								principal.groupIds.slice().sort(),
							],
				),
			)
			.digest("hex");
	}
	private encode(epoch: string, sequence: bigint, binding: string) {
		return Buffer.from(
			JSON.stringify([1, epoch, String(sequence), binding]),
		).toString("base64url");
	}
	private decode(cursor: string, epoch: string, binding: string) {
		if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
			throw new HttpError("INVALID_REQUEST");
		let value: unknown;
		try {
			value = JSON.parse(Buffer.from(cursor, "base64url").toString());
		} catch {
			throw new HttpError("INVALID_REQUEST");
		}
		if (
			!Array.isArray(value) ||
			value.length !== 4 ||
			value[0] !== 1 ||
			typeof value[2] !== "string" ||
			!/^(0|[1-9][0-9]{0,18})$/.test(value[2])
		)
			throw new HttpError("INVALID_REQUEST");
		if (value[1] !== epoch || value[3] !== binding)
			throw new HttpError("CURSOR_EXPIRED");
		return BigInt(value[2]);
	}
}
