import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { createApp } from "../../app";
import { ServerServices } from "../../core/ServerServices";
import { Config } from "../../core/config/Config";
import { HttpError } from "../../core/http/HttpError";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { RequestTracker } from "../../core/http/RequestTracker";
import { Metrics } from "../../core/observability/Metrics";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { fixtureWatermark } from "./activity.fixture";
import type { $Requests } from "../../types/application";
import type { $Operation } from "../../types/operation";

// Real production router, fetch wrapper, Bun upgrade and client. Only the
// external services are substituted; no database or Redis instance is used.
function fixture(gate?: (request: Request) => Promise<void>) {
	const services = new ServerServices(
		new Config({
			KZ_DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
			KZ_REDIS_URL: "redis://127.0.0.1:1",
			KZ_MASTER_KEY: new KeyGenerator().master(),
			KZ_LOG_LEVEL: "error",
		}),
	);
	const { tracker, metrics } = services;
	const activity = new ActivityService(
		{
			transaction: async () => {
				throw new Error("Unexpected database work");
			},
		},
		services.auth,
		{ send: async () => 1 },
		[],
		1,
		{ subscribeTimeoutMs: 200 },
		metrics,
	);
	spyOn(activity, "watermark").mockResolvedValue({ data: fixtureWatermark });
	const operation: $Operation = {
		principal: { kind: "root", id: "root", name: "Root", scopes: [] },
		clientIp: "127.0.0.1",
		requestId: "fixture",
	};
	const requests: $Requests = {
		admit: async (request) => {
			if (tracker.active > 1) throw new HttpError("SERVICE_UNAVAILABLE");
			await gate?.(request);
		},
		authorize: async (_request, peer) => {
			if (!peer) throw new Error("Upgrade lost Bun's native server argument");
			return operation;
		},
		runtime: async () => {
			throw new Error("Unexpected validation request");
		},
	};
	const app = createApp(
		{ ...services, activity, requests },
		tracker,
		services.logger,
		metrics,
	);
	app.listen({ hostname: "127.0.0.1", port: 0 });
	const url = app.server?.url;
	if (!url) throw new Error("Expected local test listener");
	const ws = (origin?: string) => {
		const address = new URL("/events/stream", url);
		address.protocol = "ws:";
		const socket = new WebSocket(address, {
			headers: origin ? { origin } : {},
		});
		const closed = new Promise<CloseEvent>((resolve) =>
			socket.addEventListener("close", resolve, { once: true }),
		);
		socket.addEventListener("error", () => {});
		return { socket, closed };
	};
	return {
		tracker,
		metrics,
		app,
		url,
		ws,
		async stop() {
			activity.stop();
			await activity.drain();
			await app.stop(true);
			services.redis.close();
			await services.database.close();
		},
	};
}

test("native upgrade rejection and idle close settle the handshake once without a message", async () => {
	const server = fixture();
	try {
		const rejected = server.ws("https://untrusted.example");
		await rejected.closed;
		expect(server.tracker.active).toBe(0);
		expect(server.metrics.text()).toContain(
			'route="/events/stream",status="403"} 1\n',
		);
		const idle = server.ws();
		await new Promise<void>((resolve) =>
			idle.socket.addEventListener("message", () => resolve(), { once: true }),
		);
		expect(server.tracker.active).toBe(0);
		expect((await fetch(new URL("/live", server.url))).status).toBe(200);
		expect((await idle.closed).code).toBe(1008);
		const result = server.metrics.text();
		expect(result).toContain('route="/events/stream",status="101"} 1\n');
		expect(result).toContain('route="/live",status="200"} 1\n');
		expect(server.tracker.active).toBe(0);
	} finally {
		await server.stop();
	}
});

test("an HTTP disconnect keeps its slot until suspended request work settles", async () => {
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const server = fixture(async (request) => {
		if (!request.headers.has("x-hold-fixture")) return;
		request.signal.addEventListener("abort", () => aborted.resolve(), {
			once: true,
		});
		entered.resolve();
		await release.promise;
	});
	const controller = new AbortController();
	const request = fetch(new URL("/live", server.url), {
		headers: { "x-hold-fixture": "true" },
		signal: controller.signal,
	}).catch(() => undefined);
	try {
		await entered.promise;
		controller.abort();
		await aborted.promise;
		expect(server.tracker.active).toBe(1);
		release.resolve();
		await request;
		const until = performance.now() + 2000;
		while (server.tracker.active && performance.now() < until)
			await Bun.sleep(2);
		expect(server.tracker.active).toBe(0);
		expect(server.metrics.text()).toContain('route="/live",status="499"} 1\n');
		// Direct app.handle goes through Elysia.fetch too; HEAD is not folded into GET.
		const head = await server.app.handle("/live", { method: "HEAD" });
		expect(server.metrics.text()).toContain(
			`method="HEAD",route="/live",status="${head.status}"} 1\n`,
		);
		expect((await fetch(new URL("/live", server.url))).status).toBe(200);
	} finally {
		release.resolve();
		await server.stop();
	}
});

test("Bun native static-route promotion does not bypass the outer fetch wrapper", async () => {
	const metrics = new Metrics();
	const tracker = new RequestTracker(metrics);
	const app = new Elysia()
		.wrap((next) => tracker.wrap(next))
		.get("/live", "static");
	app.listen({ hostname: "127.0.0.1", port: 0 });
	try {
		expect(await (await fetch(new URL("/live", app.server?.url))).text()).toBe(
			"static",
		);
		expect(await (await app.handle("/live")).text()).toBe("static");
		expect(tracker.active).toBe(0);
		expect(metrics.text()).toContain(
			'method="GET",route="/live",status="200"} 2\n',
		);
	} finally {
		await app.stop(true);
	}
});
