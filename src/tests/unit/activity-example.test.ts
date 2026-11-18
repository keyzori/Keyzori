import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
	streamEvents,
	type StagedSnapshot,
} from "../../examples/stream-events";
import { fixtureReady } from "./activity.fixture";

function peer(
	open: (socket: ServerWebSocket<{ n: number }>) => void,
	subscribe: (socket: ServerWebSocket<{ n: number }>, cursor?: string) => void,
) {
	let connections = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (request.headers.get("authorization") !== "Bearer fixture")
				return new Response(null, { status: 401 });
			if (server.upgrade(request, { data: { n: ++connections } })) return;
			return new Response(null, { status: 400 });
		},
		websocket: {
			data: {} as { n: number },
			open,
			message(socket, text) {
				const message = JSON.parse(String(text));
				expect(message.type).toBe("subscribe");
				subscribe(socket, message.cursor);
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
		count: () => connections,
	};
}

function batch(cursor: string, sequence: string, hasMore = false) {
	const id = Bun.randomUUIDv7();
	return {
		type: "events",
		cursor,
		hasMore,
		data: [
			{
				id: Bun.randomUUIDv7(),
				event: "license.updated",
				schemaVersion: 1,
				epoch: fixtureReady.watermark.epoch,
				sequence,
				createdAt: new Date().toISOString(),
				resource: { type: "license", id, revision: "1" },
				data: { licenseId: id, groupId: null },
			},
		],
	};
}

test("an unrecognized batch cannot be skipped by committing a later cursor", async () => {
	const server = peer(
		(ws) => ws.send(JSON.stringify(fixtureReady)),
		(ws) => {
			ws.send(JSON.stringify(batch("one", "1")));
			ws.send(JSON.stringify({ type: "events", data: [], hasMore: false }));
			ws.send(JSON.stringify(batch("three", "3")));
		},
	);
	const commits: unknown[] = [];
	try {
		await expect(
			streamEvents({
				...server,
				apiKey: "fixture",
				signal: new AbortController().signal,
				loadCursor: async () => "saved",
				handle: async (events, next, _signal, previous) => {
					commits.push([events[0]?.sequence, next, previous]);
				},
			}),
		).rejects.toThrow("Invalid activity protocol frame");
		expect(commits).toEqual([["1", "one", "saved"]]);
		expect(server.count()).toBe(1);
	} finally {
		await server.stop();
	}
});

test.each([
	[{ ...fixtureReady, schemaVersion: 2 }, "Invalid activity protocol"],
	[batch("early", "1"), "Unexpected activity batch"],
	[{ type: "error", code: "FORBIDDEN" }, "FORBIDDEN"],
])(
	"incompatible ordering/version and permanent errors stop before writing",
	async (frame, error) => {
		const server = peer(
			(ws) => ws.send(JSON.stringify(frame)),
			() => {},
		);
		try {
			await expect(
				streamEvents({
					...server,
					apiKey: "fixture",
					signal: new AbortController().signal,
					loadCursor: async () => undefined,
					handle: async () => {
						throw new Error("Unexpected commit");
					},
				}),
			).rejects.toThrow(String(error));
			expect(server.count()).toBe(1);
		} finally {
			await server.stop();
		}
	},
);

test("resync stages a scan off-socket, discards changed authority and promotes only after catch-up", async () => {
	const controller = new AbortController();
	const writes: unknown[] = [];
	const subscribers: unknown[] = [];
	const server = peer(
		(ws) =>
			ws.send(
				JSON.stringify({
					...fixtureReady,
					watermark: { ...fixtureReady.watermark, cursor: `mark-${ws.data.n}` },
				}),
			),
		(ws, cursor) => {
			subscribers.push(cursor);
			if (ws.data.n === 2) {
				ws.send(
					JSON.stringify({
						type: "error",
						code: "CURSOR_EXPIRED",
						resync: "/events/watermark",
					}),
				);
				ws.close(1008);
			} else {
				ws.send(JSON.stringify(batch("first-page", "2", true)));
				ws.send(JSON.stringify(batch("caught-up", "3")));
			}
		},
	);
	try {
		await streamEvents({
			...server,
			apiKey: "fixture",
			signal: controller.signal,
			loadCursor: async () => undefined,
			handle: async () => {
				throw new Error("Stage must receive catch-up events");
			},
			stageSnapshot: async (mark): Promise<StagedSnapshot> => ({
				async apply(page, publish) {
					writes.push([mark.cursor, page.previousCursor, page.cursor, publish]);
					if (publish) setTimeout(() => controller.abort(), 0);
				},
				async discard() {
					writes.push(["discard", mark.cursor]);
				},
			}),
		});
		expect(subscribers).toEqual(["mark-1", "mark-3"]);
		expect(writes).toEqual([
			["discard", "mark-1"],
			["mark-3", "mark-3", "first-page", false],
			["mark-3", "first-page", "caught-up", true],
		]);
	} finally {
		controller.abort();
		await server.stop();
	}
});

test("abort cancels a blocked callback without starting another checkpoint writer", async () => {
	const controller = new AbortController();
	const server = peer(
		(ws) => ws.send(JSON.stringify(fixtureReady)),
		(ws) => {
			ws.send(JSON.stringify(batch("pending", "1")));
			ws.send(JSON.stringify(batch("not-committed", "2")));
		},
	);
	const entered = Promise.withResolvers<AbortSignal>();
	const late = Promise.withResolvers<void>();
	let handles = 0;
	const client = streamEvents({
		...server,
		apiKey: "fixture",
		signal: controller.signal,
		loadCursor: async () => undefined,
		handle: async (_events, _cursor, signal) => {
			handles++;
			entered.resolve(signal);
			await late.promise;
		},
	});
	try {
		const signal = await entered.promise;
		controller.abort();
		await client;
		expect(signal.aborted).toBe(true);
		expect(handles).toBe(1);
		expect(server.count()).toBe(1);
	} finally {
		controller.abort();
		late.resolve();
		await server.stop();
	}
});

test("periodic refresh uses a new validated watermark without changing grants or discarding a durable cursor", async () => {
	const controller = new AbortController();
	const subscribers: unknown[] = [];
	const commits: string[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let durable = "previous";
	const server = peer(
		(ws) => ws.send(JSON.stringify(fixtureReady)),
		(ws, cursor) => {
			subscribers.push(cursor);
			if (ws.data.n === 1)
				timer = setTimeout(
					() => ws.send(JSON.stringify(batch("live-checkpoint", "1"))),
					1010,
				);
			else
				ws.send(
					JSON.stringify({
						type: "events",
						data: [],
						hasMore: false,
						cursor: "refreshed",
					}),
				);
		},
	);
	try {
		await streamEvents({
			...server,
			signal: controller.signal,
			apiKey: "fixture",
			refreshIntervalMs: 1000,
			loadCursor: async () => durable,
			handle: async (_events, next) => {
				durable = next;
			},
			stageSnapshot: async () => {
				expect(durable).toBe("live-checkpoint");
				return {
					async apply(page, publish) {
						expect(publish).toBe(true);
						commits.push(page.cursor);
						setTimeout(() => controller.abort(), 0);
					},
					async discard() {
						throw new Error("Already published");
					},
				};
			},
		});
		expect(subscribers).toEqual(["previous", fixtureReady.watermark.cursor]);
		expect(commits).toEqual(["refreshed"]);
	} finally {
		clearTimeout(timer);
		controller.abort();
		await server.stop();
	}
});
