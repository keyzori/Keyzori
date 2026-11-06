import { expect, test } from "bun:test";
import { Elysia, TypeBoxValidator, ValidationError, t } from "elysia";
import { HttpBoundary } from "../../core/http/HttpBoundary";
import { HttpError } from "../../core/http/HttpError";
import { RequestTracker } from "../../core/http/RequestTracker";
import { responseValidator, success } from "../../core/http/Response";
import { Logger } from "../../core/observability/Logger";
import { Replay } from "../../core/security/Replay";
import { validationModel } from "../../plugins/validate/model";
import { licenseModel } from "../../plugins/licenses/model";
import referenceApp from "../../scripts/reference-app";
import { checkedJSON } from "../fixtures/Json";

const boundary = new HttpBoundary(new RequestTracker(), new Logger("error"));
const request = () => new Request("http://localhost/test");

test("full licence schemas compile and accept empty validation/list responses", () => {
	responseValidator(validationModel.response)(
		{
			data: {
				valid: false,
				code: "LICENSE_INVALID",
				reason: "Invalid licence",
				evaluatedAt: new Date().toISOString(),
				license: null,
			},
		},
		200,
	);
	responseValidator(licenseModel.read)(
		{ data: [], nextCursor: null, pageLimit: 50 },
		200,
	);
	responseValidator(
		referenceApp.routes.find(
			(route) => route.path === "/validate" && route.method === "POST",
		)?.hooks.response,
	)(
		{
			data: {
				valid: false,
				code: "LICENSE_INVALID",
				reason: "Invalid licence",
				evaluatedAt: new Date().toISOString(),
				license: null,
			},
		},
		200,
	);
	responseValidator(
		referenceApp.routes.find(
			(route) => route.path === "/licenses" && route.method === "GET",
		)?.hooks.response,
	)({ data: [], nextCursor: null, pageLimit: 50 }, 200);
	const events = responseValidator(
		referenceApp.routes.find(
			(route) => route.path === "/events" && route.method === "GET",
		)?.hooks.response,
	);
	events({ data: [], cursor: "cursor", hasMore: false, pageLimit: 50 }, 200);
	expect(() => events({ data: "invalid" }, 200)).toThrow(ValidationError);
});

test("pagination reports the effective service limit and preserves one-time fields", () => {
	expect(
		success({ data: [], nextCursor: "next", pageLimit: 17 }, "request"),
	).toEqual({
		ok: true,
		data: [],
		error: null,
		meta: {
			requestId: "request",
			page: { limit: 17, nextCursor: "next", hasMore: true },
		},
	});
	expect(
		success(
			{ data: [], cursor: "cursor", hasMore: false, pageLimit: 8 },
			"request",
		).meta.page,
	).toEqual({ limit: 8, nextCursor: "cursor", hasMore: false });
	expect(
		success({ data: { id: "id" }, secret: "once" }, "request"),
	).toMatchObject({ data: { id: "id", secret: "once" } });
	expect(
		success({ data: { id: "id" }, credential: "once" }, "request"),
	).toMatchObject({ data: { id: "id", credential: "once" } });
});

test("secret replay errors retain only safe resource IDs, and successful replays retain metadata", async () => {
	const id = Bun.randomUUIDv7();
	const response = boundary.error(
		new HttpError("SECRET_ALREADY_ISSUED", undefined, [id, id, "SECRET"]),
		request(),
	);
	expect(response.status).toBe(409);
	expect(
		(
			await checkedJSON(
				response,
				t.Object({ error: t.Object({ resourceIds: t.Array(t.String()) }) }),
			)
		).error.resourceIds,
	).toEqual([id]);
	const replay = await checkedJSON(
		boundary.error(
			new Replay({ data: [], nextCursor: null, pageLimit: 12 }),
			request(),
		),
		t.Object({
			meta: t.Object({
				operation: t.Object({ replayed: t.Boolean() }),
				page: t.Object({ limit: t.Integer(), hasMore: t.Boolean() }),
			}),
		}),
	);
	expect(replay.meta).toMatchObject({
		operation: { replayed: true },
		page: { limit: 12, hasMore: false },
	});
});

test("validation errors expose schema fields without values, dynamic keys or unsafe diagnostics", async () => {
	const schema = t.Object(
		{
			license: t.String(),
			changes: t.Object({ enabled: t.Boolean() }),
			metadata: t.Record(t.String(), t.String()),
		},
		{ additionalProperties: false },
	);
	const value = {
		license: 42,
		changes: { enabled: "SECRET_VALUE" },
		metadata: { SECRET_KEY: 42 },
	};
	const validator = new TypeBoxValidator(schema);
	const response = boundary.error(
		new ValidationError("body", value, () => validator.Errors(value), schema),
		request(),
	);
	expect(response.status).toBe(400);
	const body = await checkedJSON(
		response,
		t.Object({
			error: t.Object({
				details: t.Array(t.Object({ path: t.String(), message: t.String() })),
			}),
		}),
	);
	expect(body.error.details).toContainEqual({
		path: "body.license",
		message: "Invalid value",
	});
	expect(body.error.details).toContainEqual({
		path: "body.changes.enabled",
		message: "Invalid value",
	});
	expect(body.error.details).toContainEqual({
		path: "body.metadata.*",
		message: "Invalid value",
	});
	expect(JSON.stringify(body)).not.toContain("SECRET");
	expect(JSON.stringify(body)).not.toContain("schema");
});

test("response schemas are checked before an envelope becomes a native Response", async () => {
	const schema = t.Object(
		{ expected: t.String() },
		{ additionalProperties: false },
	);
	const check = responseValidator(schema);
	const app = new Elysia({ normalize: false })
		.mapResponse(({ responseValue }) => {
			if (responseValue instanceof Response) return;
			check(responseValue, 200);
			return Response.json(success(responseValue, "request"));
		})
		.error(({ error, request }) => boundary.error(error, request))
		.get("/bad", { response: schema }, () =>
			JSON.parse('{"credential":"SECRET"}'),
		)
		.get("/good", { response: schema }, () => ({ expected: "valid" }));
	const good = await app.handle(new Request("http://localhost/good"));
	expect(good.status).toBe(200);
	expect(await good.json()).toMatchObject({
		ok: true,
		data: { expected: "valid" },
	});
	const bad = await app.handle(new Request("http://localhost/bad"));
	expect(bad.status).toBe(500);
	const text = await bad.text();
	expect(text).toContain("INTERNAL_ERROR");
	expect(text).not.toContain("SECRET");
});

test("body admission returns structured 413 before parsing an oversized request", async () => {
	const app = new Elysia({ serve: { maxRequestBodySize: 16777216 } })
		.request(({ request }) => {
			boundary.start(request);
		})
		.parse(({ request }) => boundary.parse(request))
		.error(({ error, request }) => boundary.error(error, request))
		.post("/", { body: t.Unknown() }, () => ({ accepted: true }))
		.listen({ hostname: "127.0.0.1", port: 0 });
	try {
		if (!app.server) throw new Error("Server failed to start");
		const response = await fetch(app.server.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ data: "x".repeat(1048576) }),
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			ok: false,
			error: { code: "PAYLOAD_TOO_LARGE" },
		});
		const streamed = await fetch(app.server.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					for (let i = 0; i < 5; i++)
						controller.enqueue(new Uint8Array(262144));
					controller.close();
				},
			}),
		});
		expect(streamed.status).toBe(413);
		expect(await streamed.json()).toMatchObject({
			ok: false,
			error: { code: "PAYLOAD_TOO_LARGE" },
		});
	} finally {
		await app.stop(true);
	}
});
