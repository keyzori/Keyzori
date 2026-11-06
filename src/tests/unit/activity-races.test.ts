import { expect, spyOn, test } from "bun:test";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { AuthService } from "../../core/auth/AuthService";
import type { Database } from "../../core/database/Database";
import type { $Operation } from "../../types/operation";
import type { ActivityOptions } from "../../plugins/activity/options";

const database: Pick<Database, "transaction"> = {
	transaction: async () => {
		throw new Error("Unexpected database call");
	},
};
const auth = new AuthService(database, "test-root-credential");
const operation: $Operation = {
	principal: { kind: "root", id: "root", name: "Root", scopes: [] },
	requestId: "request",
	clientIp: "127.0.0.1",
};

function fixture(options: ActivityOptions = {}) {
	const admission = Promise.withResolvers<unknown>();
	let releases = 0;
	const redis = {
		send: async (_command: string, args: string[]) => {
			if (args[0]?.includes("ZADD")) return admission.promise;
			releases++;
			return 1;
		},
	};
	const frames: unknown[] = [];
	const closed: { code?: number; reason?: string }[] = [];
	const socket = {
		id: Bun.randomUUIDv7(),
		send(value: unknown) {
			const parsed: unknown =
				typeof value === "string" ? JSON.parse(value) : value;
			frames.push(parsed);
			return 1;
		},
		close(code?: number, reason?: string) {
			closed.push({ code, reason });
		},
	};
	return {
		service: new ActivityService(database, auth, redis, [], 100, options),
		socket,
		admission,
		frames,
		closed,
		releases: () => releases,
	};
}

test("a lease acquired after socket close is released without sending ready", async () => {
	const { service, socket, admission, frames, releases } = fixture();
	const opening = service.open(socket, operation);
	service.close(socket.id);
	admission.resolve(1);
	await opening;
	expect(frames).toEqual([]);
	expect(releases()).toBe(2);
	service.stop();
});

test("a batch completing after stop cannot send or resurrect a session", async () => {
	const { service, socket, admission, frames } = fixture();
	const pending =
		Promise.withResolvers<Awaited<ReturnType<ActivityService["read"]>>>();
	const read = spyOn(service, "read").mockReturnValue(pending.promise);
	try {
		admission.resolve(1);
		await service.open(socket, operation);
		const subscribing = service.subscribe(socket.id);
		await Promise.resolve();
		service.stop();
		pending.resolve({
			data: [],
			pageLimit: 100,
			cursor: "stale",
			hasMore: true,
		});
		await subscribing;
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ type: "ready" });
		await service.open(socket, operation);
		expect(frames).toHaveLength(1);
	} finally {
		service.stop();
		read.mockRestore();
	}
});

test("a slow read is fenced by the independent lease watchdog", async () => {
	const { service, socket, admission, frames, closed } = fixture({
		leaseMs: 100,
		leaseSafetyMs: 20,
		renewEveryMs: 20,
		pollIntervalMs: 10,
	});
	const pending =
		Promise.withResolvers<Awaited<ReturnType<ActivityService["read"]>>>();
	const read = spyOn(service, "read").mockReturnValue(pending.promise);
	try {
		admission.resolve(1);
		await service.open(socket, operation);
		const subscribing = service.subscribe(socket.id);
		await Bun.sleep(120);
		expect(closed).toContainEqual({
			code: 1008,
			reason: "Session or lease expired",
		});
		pending.resolve({
			data: [],
			pageLimit: 100,
			cursor: "late",
			hasMore: false,
		});
		await subscribing;
		expect(frames).toHaveLength(1);
	} finally {
		service.stop();
		read.mockRestore();
	}
});

test("zero or negative transport sends close immediately without a next batch", async () => {
	for (const status of [0, -1]) {
		const { service, socket, admission, closed } = fixture();
		const read = spyOn(service, "read").mockResolvedValue({
			data: [],
			pageLimit: 100,
			cursor: "processed",
			hasMore: true,
		});
		try {
			admission.resolve(1);
			await service.open(socket, operation);
			const send = spyOn(socket, "send").mockReturnValue(status);
			await service.subscribe(socket.id);
			expect(closed).toContainEqual({
				code: 1013,
				reason: "Slow consumer; reconnect with processed cursor",
			});
			expect(read).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledTimes(1);
		} finally {
			service.stop();
			read.mockRestore();
		}
	}
});

test("an early subscribe waits for lease admission before reading or sending events", async () => {
	const { service, socket, admission, frames } = fixture();
	const read = spyOn(service, "read").mockResolvedValue({
		data: [],
		pageLimit: 100,
		cursor: "cursor",
		hasMore: false,
	});
	try {
		const opening = service.open(socket, operation);
		const subscription = service.subscribe(socket.id);
		expect(read).not.toHaveBeenCalled();
		expect(frames).toEqual([]);
		admission.resolve(1);
		await opening;
		await subscription;
		expect(frames).toHaveLength(2);
		expect(frames[0]).toMatchObject({ type: "ready" });
		expect(frames[1]).toMatchObject({ type: "events", cursor: "cursor" });
	} finally {
		service.stop();
		read.mockRestore();
	}
});
