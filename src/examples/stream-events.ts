import { Check } from "typebox/value";
import type { Static } from "typebox";
import {
	activityCursorSchema,
	activityServerFrameSchema,
	activityWatermarkSchema,
} from "../plugins/activity/model";
import type { $PublishedEvent } from "../types/webhooks";

type Watermark = Static<typeof activityWatermarkSchema>;
type Batch = {
	events: readonly $PublishedEvent[];
	cursor: string;
	previousCursor?: string;
	epoch: string;
};

/** A private replacement projection. Never expose a partial scan or replay page. */
export type StagedSnapshot = {
	/** Persist invalidations and cursor together; when publish is true, swap the whole projection atomically. */
	apply(batch: Batch, publish: boolean, signal: AbortSignal): Promise<void>;
	/** Delete only this unpublished stage. Never delete a promoted generation. */
	discard(signal: AbortSignal): Promise<void>;
};
type Options = {
	url: string;
	apiKey: string;
	loadCursor(signal: AbortSignal): Promise<string | undefined>;
	/** Refetch serially; atomically commit the results and cursor (CAS previousCursor). */
	handle(
		events: readonly $PublishedEvent[],
		nextCursor: string,
		signal: AbortSignal,
		previousCursor?: string,
	): Promise<void>;
	/** Collect authorized pages in isolated storage using this watermark captured BEFORE the scan. */
	stageSnapshot?(
		watermark: Watermark,
		signal: AbortSignal,
	): Promise<StagedSnapshot>;
	signal: AbortSignal;
	workTimeoutMs?: number;
	/** With stageSnapshot, periodically rebuild projections that the event grants do not fully cover. */
	refreshIntervalMs?: number;
};
type ActiveStage = {
	writer: StagedSnapshot;
	epoch: string;
	cursor: string;
	sequence: bigint;
	writing: boolean;
};
type Next = "retry" | "expired" | "refresh" | Watermark;

/** Cancellation/deadline is terminal for this writer: never reconnect behind an uncertain commit. */
async function work<T>(
	parent: AbortSignal,
	timeout: number,
	run: (signal: AbortSignal) => Promise<T>,
) {
	parent.throwIfAborted();
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, parent]);
	const timer = setTimeout(
		() => controller.abort(new Error("Stream storage deadline expired")),
		timeout,
	);
	const cancelled = Promise.withResolvers<never>();
	const abort = () => cancelled.reject(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([
			cancelled.promise,
			Promise.resolve().then(() => {
				signal.throwIfAborted();
				return run(signal);
			}),
		]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

function parseFrame(text: string) {
	const frame: unknown = JSON.parse(text);
	if (!Check(activityServerFrameSchema, frame))
		throw new Error("Invalid activity protocol frame");
	return frame;
}

async function connection(
	options: Options,
	cursor: string | undefined,
	collect: boolean,
	state: { stage?: ActiveStage; refreshAt: number },
	timeout: number,
) {
	const socket = new WebSocket(options.url, {
		headers: { authorization: `Bearer ${options.apiKey}` },
	});
	const local = new AbortController();
	const signal = AbortSignal.any([options.signal, local.signal]);
	const closed = Promise.withResolvers<void>();
	let accepting = true;
	const end = () => {
		accepting = false;
		closed.resolve();
	};
	const terminate = () => {
		end();
		socket.terminate();
	};
	let failure: Error | undefined;
	const outcome: { next?: Next } = {};
	let ready: Watermark | undefined;
	let subscribed = false;
	let sequence = state.stage?.sequence ?? 0n;
	let previousCursor = cursor;
	let queued = 0;
	let lastMessage = performance.now();
	let processing = Promise.resolve();
	const started = performance.now();
	const handshake = setTimeout(terminate, 15000);
	const heartbeat = setInterval(() => {
		if (performance.now() - lastMessage > 40000) terminate();
	}, 10000);
	const fail = (error: unknown) => {
		failure ??=
			error instanceof Error ? error : new Error("Stream processing failed");
		local.abort(failure);
		terminate();
	};
	async function processFrame(raw: string) {
		if (failure || outcome.next !== undefined || signal.aborted) return;
		const frame = parseFrame(raw);
		if (frame.type === "error") {
			if (frame.code === "CURSOR_EXPIRED") outcome.next = "expired";
			else if (frame.code !== "SERVICE_UNAVAILABLE")
				throw new Error(`Activity stream: ${frame.code}`);
			else outcome.next = "retry";
			subscribed = false;
			terminate();
			return;
		}
		if (frame.type === "ready") {
			if (
				ready ||
				BigInt(frame.watermark.retainedAfter) > BigInt(frame.watermark.sequence)
			)
				throw new Error("Invalid activity ready frame");
			clearTimeout(handshake);
			ready = frame.watermark;
			if (collect || (state.stage && state.stage.epoch !== ready.epoch)) {
				outcome.next = collect ? ready : "expired";
				terminate(); // A resource scan is not constrained by the socket subscribe deadline.
				return;
			}
			if (socket.readyState !== WebSocket.OPEN) return;
			socket.send(JSON.stringify({ type: "subscribe", cursor }));
			subscribed = true;
			return;
		}
		if (!ready || !subscribed || (frame.hasMore && !frame.data.length))
			throw new Error("Unexpected activity batch");
		for (const event of frame.data) {
			const position = BigInt(event.sequence);
			if (event.epoch !== ready.epoch || position <= sequence)
				throw new Error("Activity history changed or arrived out of order");
			sequence = position;
		}
		const batch = {
			events: frame.data,
			cursor: frame.cursor,
			previousCursor,
			epoch: ready.epoch,
		};
		const stage = state.stage;
		if (stage) {
			await work(signal, timeout, async (s) => {
				stage.writing = true;
				try {
					await stage.writer.apply(batch, !frame.hasMore, s);
				} finally {
					stage.writing = false;
				}
			});
			if (!frame.hasMore) {
				state.stage = undefined;
				state.refreshAt =
					performance.now() + (options.refreshIntervalMs ?? Infinity);
			} else {
				stage.cursor = batch.cursor;
				stage.sequence = sequence;
			}
		} else
			await work(signal, timeout, (s) =>
				options.handle(batch.events, batch.cursor, s, previousCursor),
			);
		previousCursor = batch.cursor; // Only after the consumer's transaction has committed.
		if (!state.stage && performance.now() >= state.refreshAt) {
			outcome.next = "refresh";
			terminate();
		}
	}
	socket.addEventListener("message", ({ data }) => {
		lastMessage = performance.now();
		if (!accepting || failure || signal.aborted) return;
		if (
			++queued > 32 ||
			typeof data !== "string" ||
			Buffer.byteLength(data) > 262144
		) {
			fail(new Error("Activity consumer exceeded its queue or frame limit"));
			return;
		}
		processing = processing
			.then(() => processFrame(data))
			.catch(fail)
			.finally(() => {
				queued--;
			});
	});
	socket.addEventListener("error", end, { once: true });
	socket.addEventListener("close", end, { once: true });
	options.signal.addEventListener("abort", terminate, { once: true });
	try {
		if (options.signal.aborted) terminate();
		await closed.promise;
		await processing;
		if (failure) throw failure;
		return {
			next: outcome.next ?? "retry",
			ready: !!ready,
			stable: subscribed && performance.now() - started > 30000,
		};
	} finally {
		clearTimeout(handshake);
		clearInterval(heartbeat);
		options.signal.removeEventListener("abort", terminate);
		socket.terminate();
	}
}

function backoff(attempt: number, signal: AbortSignal) {
	return new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(
			done,
			Math.min(
				30000,
				500 * 2 ** Math.min(attempt, 6) * (0.8 + Math.random() * 0.4),
			),
		);
		signal.addEventListener("abort", done, { once: true });
		if (signal.aborted) done();
	});
}

/**
 * A backend consumer; use one writer per durable checkpoint. Storage callbacks must
 * honor their signal and fence commits (including snapshot promotion) in storage.
 * Quarantine obsolete projections on resync, reset revision high-waters on epoch
 * changes, and keep separate durable IDs for irreversible side effects.
 *
 * Events invalidate authorized event families, not every field of every GET. For
 * example, a licence-only reader misses usage events, and selected groups miss
 * global linked-user edits. Supply stageSnapshot and e.g. refreshIntervalMs:
 * 300_000 to periodically rebuild via authorized reads; never apply historical
 * payloads as current state. Set the interval to the staleness your application accepts.
 */
export async function streamEvents(options: Options) {
	const timeout = options.workTimeoutMs ?? 60000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
		throw new Error("Invalid storage deadline");
	const interval = options.refreshIntervalMs;
	if (
		interval !== undefined &&
		(!options.stageSnapshot ||
			!Number.isSafeInteger(interval) ||
			interval < 1000)
	)
		throw new Error(
			"Periodic refresh needs a snapshot writer and an interval of at least one second",
		);
	let attempt = 0;
	let missedHandshakes = 0;
	let resync = false;
	const state: { stage?: ActiveStage; refreshAt: number } = {
		refreshAt: performance.now() + (interval ?? Infinity),
	};
	async function discard() {
		const stage = state.stage;
		state.stage = undefined;
		// A noncooperative store may still have an unknown-outcome write. Do
		// not race it with deletion; abandoned private stages need a store TTL.
		if (stage && !stage.writing)
			await work(new AbortController().signal, timeout, (s) =>
				stage.writer.discard(s),
			);
	}
	try {
		while (!options.signal.aborted) {
			const cursor =
				state.stage?.cursor ??
				(resync
					? undefined
					: await work(options.signal, timeout, (s) => options.loadCursor(s)));
			if (options.signal.aborted) return;
			if (cursor !== undefined && !Check(activityCursorSchema, cursor))
				throw new Error("Invalid saved activity cursor");
			const collect = cursor === undefined && !!options.stageSnapshot;
			const result = await connection(options, cursor, collect, state, timeout);
			if (options.signal.aborted) return;
			missedHandshakes = result.ready ? 0 : missedHandshakes + 1;
			if (result.next === "refresh") {
				resync = true;
				continue;
			}
			const stageSnapshot = options.stageSnapshot;
			if (typeof result.next === "object" && stageSnapshot) {
				const watermark = result.next;
				const writer = await work(options.signal, timeout, (s) =>
					stageSnapshot(watermark, s),
				);
				state.stage = {
					writer,
					cursor: watermark.cursor,
					epoch: watermark.epoch,
					sequence: BigInt(watermark.sequence),
					writing: false,
				};
				resync = false;
				continue;
			}
			if (result.next === "expired") {
				await discard();
				if (!options.stageSnapshot)
					throw new Error(
						"CURSOR_EXPIRED: resynchronize authorized state before restarting",
					);
				resync = true;
			}
			if (missedHandshakes >= 8)
				throw new Error(
					"Activity handshake repeatedly failed; check service and credentials",
				);
			if (result.stable) attempt = 0;
			await backoff(attempt++, options.signal);
		}
	} catch (error) {
		if (!options.signal.aborted) throw error;
	} finally {
		await discard();
	}
}
