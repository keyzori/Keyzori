import { expect, spyOn, test } from "bun:test";
import type { OperationalGauge } from "../../core/observability/Metrics";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { AuthService } from "../../core/auth/AuthService";
import type { Database } from "../../core/database/Database";
import { transportBufferedBytes } from "../../plugins/activity/SocketQueue";
import type { $Operation } from "../../types/operation";

const database: Pick<Database, "transaction"> = {
	transaction: async () => {
		throw new Error("Unexpected database call");
	},
};
const operation: $Operation = {
	principal: { kind: "root", id: "root", name: "Root", scopes: [] },
	requestId: "metrics-fixture",
	clientIp: "127.0.0.1",
};

test("stream gauges track local admission, exact serialized frames and backpressure cleanup", async () => {
	const gauges = new Map<OperationalGauge, number>();
	const service = new ActivityService(
		database,
		new AuthService(database, "fixture"),
		{ send: async () => 1 },
		[],
		100,
		{},
		{
			setGauge: (name, value) => {
				gauges.set(name, value);
			},
		},
	);
	const read = spyOn(service, "read").mockResolvedValue({
		data: [],
		pageLimit: 100,
		hasMore: true,
		cursor: "processed-✓",
	});
	let status = 1;
	const frames: string[] = [];
	const closes: number[] = [];
	const socket = {
		id: Bun.randomUUIDv7(),
		send(frame: unknown) {
			if (typeof frame !== "string")
				throw new Error("Expected serialized protocol frame");
			expect(gauges.get("keyzori_streams_active")).toBe(1);
			expect(gauges.get("keyzori_stream_queue_messages")).toBe(1);
			expect(gauges.get("keyzori_stream_queue_bytes")).toBe(
				Buffer.byteLength(frame),
			);
			frames.push(frame);
			return status;
		},
		close(code = 1000) {
			closes.push(code);
		},
	};
	try {
		expect(gauges.get("keyzori_streams_active")).toBe(0);
		await service.open(socket, operation);
		expect(gauges.get("keyzori_stream_queue_messages")).toBe(0);
		expect(gauges.get("keyzori_stream_queue_bytes")).toBe(0);
		status = -1;
		await service.subscribe(socket.id);
		expect(frames).toHaveLength(2);
		expect(closes).toEqual([1013]);
		expect(gauges.get("keyzori_streams_active")).toBe(0);
		expect(gauges.get("keyzori_stream_queue_messages")).toBe(0);
		expect(gauges.get("keyzori_stream_queue_bytes")).toBe(0);
	} finally {
		service.stop();
		read.mockRestore();
	}
});

test("transport queue sampling distinguishes unsupported, invalid and measured-empty sockets", () => {
	expect(transportBufferedBytes({})).toBeUndefined();
	expect(transportBufferedBytes({ raw: {} })).toBeUndefined();
	expect(transportBufferedBytes({ raw: { getBufferedAmount: () => 0 } })).toBe(
		0,
	);
	expect(
		transportBufferedBytes({
			raw: {
				queued: 137,
				getBufferedAmount() {
					return this.queued;
				},
			},
		}),
	).toBe(137);
	for (const value of [-1, NaN, Infinity, "0", undefined])
		expect(
			transportBufferedBytes({ raw: { getBufferedAmount: () => value } }),
		).toBeUndefined();
	expect(
		transportBufferedBytes({
			raw: {
				getBufferedAmount() {
					throw new Error("closed socket");
				},
			},
		}),
	).toBeUndefined();
});
