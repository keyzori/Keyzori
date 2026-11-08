import { createHmac, timingSafeEqual } from "node:crypto";

const keys = new Map<string, string>();
const calls: {
	path: string;
	valid: boolean;
	deliveryId: string;
	eventId: string;
}[] = [];
const held = new Set<() => void>();
let cancelled = 0;
const directory = Bun.env.FIXTURE_CERTIFICATES ?? "/fixture";
const token = Bun.env.FIXTURE_CONTROL_TOKEN;
if (!token) throw new Error("Fixture control token is required");

for (const [name, port] of [
	["trusted", 8443],
	["untrusted", 8444],
] as const) {
	Bun.serve({
		hostname: "0.0.0.0",
		port,
		tls: {
			key: Bun.file(`${directory}/${name}.key`),
			cert: Bun.file(`${directory}/${name}.pem`),
		},
		fetch: async (request) => {
			const body = await request.text();
			const deliveryId = request.headers.get("x-keyzori-delivery-id") ?? "";
			const eventId = request.headers.get("x-keyzori-event-id") ?? "";
			const timestamp = request.headers.get("x-keyzori-timestamp") ?? "";
			const secret = keys.get(
				request.headers.get("x-keyzori-signing-key-id") ?? "",
			);
			const signature = request.headers.get("x-keyzori-signature") ?? "";
			const expected = secret
				? `v1=${createHmac("sha256", Buffer.from(secret, "hex")).update(`${timestamp}.${deliveryId}.${body}`).digest("hex")}`
				: "";
			const payload: unknown = JSON.parse(body);
			const valid =
				Boolean(secret) &&
				signature.length === expected.length &&
				timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) &&
				Math.abs(Date.now() / 1000 - Number(timestamp)) < 300 &&
				Boolean(
					payload &&
					typeof payload === "object" &&
					"id" in payload &&
					payload.id === eventId,
				);
			const path = new URL(request.url).pathname;
			calls.push({ path, valid, deliveryId, eventId });
			if (!valid) return new Response(null, { status: 401 });
			if (path === "/redirect")
				return new Response(null, {
					status: 302,
					headers: { location: "/unexpected-follow" },
				});
			if (path === "/hold" || path === "/cancel")
				await new Promise<void>((resolve) => {
					const release = () => {
						held.delete(release);
						resolve();
					};
					held.add(release);
					request.signal.addEventListener(
						"abort",
						() => {
							cancelled++;
							release();
						},
						{ once: true },
					);
				});
			return new Response(null, { status: 204 });
		},
	});
}

Bun.serve({
	hostname: "0.0.0.0",
	port: 8080,
	fetch: async (request) => {
		if (request.headers.get("authorization") !== `Bearer ${token}`)
			return new Response(null, { status: 401 });
		const path = new URL(request.url).pathname;
		if (request.method === "POST" && path === "/keys") {
			const body: unknown = await request.json();
			if (
				!body ||
				typeof body !== "object" ||
				!("id" in body) ||
				!("secret" in body) ||
				typeof body.id !== "string" ||
				typeof body.secret !== "string"
			)
				return new Response(null, { status: 400 });
			keys.set(body.id, body.secret);
		}
		if (request.method === "POST" && path === "/release")
			for (const release of held) release();
		return Response.json({ calls, cancelled, held: held.size });
	},
});
