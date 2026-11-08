import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { request } from "node:https";
import type { Duplex } from "node:stream";
import { isIP } from "node:net";
import {
	WebhookTransport,
	parseWebhookPrivateDestinations,
} from "../../plugins/webhooks/WebhookTransport";
import { webhookTlsFixture } from "../integration/webhook-tls.fixture";

test("operator private-destination parsing is bounded and accepts only origins plus native CIDRs", () => {
	expect(parseWebhookPrivateDestinations(undefined)).toEqual([]);
	expect(
		parseWebhookPrivateDestinations([
			{
				origin: "HTTPS://Receiver.Example:443",
				cidrs: ["127.0.0.0/8", "::1/128", "::ffff:127.0.0.0/104"],
			},
		]),
	).toEqual([
		{
			origin: "https://receiver.example",
			cidrs: ["127.0.0.0/8", "::1/128", "::ffff:127.0.0.0/104"],
		},
	]);
	for (const origin of [
		"http://receiver.example/",
		"http://receiver.example/path",
		"http://receiver.example?x=1",
		"http://receiver.example#x",
		"http://user:password@receiver.example",
		"ftp://receiver.example",
		"https:\\receiver.example",
		" https://receiver.example",
	])
		expect(() =>
			parseWebhookPrivateDestinations([{ origin, cidrs: ["127.0.0.1/32"] }]),
		).toThrow();
	for (const cidr of [
		"127.0.0.1",
		"127.1/8",
		"localhost/32",
		"127.0.0.1/33",
		"127.0.0.1/-1",
		"127.0.0.1/01",
		"127.0.0.1/32/1",
		"::1/129",
		"fe80::1%lo/128",
		"::ffff:127.0.0.1/999",
		" 127.0.0.1/32",
	])
		expect(() =>
			parseWebhookPrivateDestinations([
				{ origin: "https://receiver.example", cidrs: [cidr] },
			]),
		).toThrow();
	for (const invalid of [
		null,
		{},
		[{ origin: "https://receiver.example", cidrs: [] }],
		[{ origin: "https://receiver.example", cidrs: [1] }],
		[
			{
				origin: "https://receiver.example",
				cidrs: ["127.0.0.1/32"],
				allowPrivate: true,
			},
		],
		[
			{ origin: "https://receiver.example", cidrs: ["127.0.0.1/32"] },
			{ origin: "https://RECEIVER.example:443", cidrs: ["127.0.0.2/32"] },
		],
		Array.from({ length: 33 }, (_, i) => ({
			origin: `https://receiver-${i}.example`,
			cidrs: ["127.0.0.1/32"],
		})),
		[
			{
				origin: "https://receiver.example",
				cidrs: Array(33).fill("127.0.0.1/32"),
			},
		],
	])
		expect(() => parseWebhookPrivateDestinations(invalid)).toThrow();
	expect(
		parseWebhookPrivateDestinations(
			Array.from({ length: 32 }, (_, i) => ({
				origin: `https://receiver-${i}.example`,
				cidrs: Array(32).fill("127.0.0.1/32"),
			})),
		),
	).toHaveLength(32);
});

test("real private HTTPS pins loopback and mapped IPv6 while retaining verified Host/SNI", async () => {
	const hosts: (string | undefined)[] = [];
	const fixture = await webhookTlsFixture((incoming, response) => {
		hosts.push(incoming.headers.host);
		response.writeHead(204).end();
	});
	const origin = `https://receiver.example:${fixture.port}`;
	const policy = [{ origin, cidrs: ["127.0.0.1/32"] }];
	let connected = 0;
	try {
		for (const address of ["127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
			const transport = new WebhookTransport(
				[],
				async () => [{ address, family: isIP(address) }],
				(options, callback) => {
					connected++;
					expect(options.hostname).toBe("127.0.0.1");
					expect(options.family).toBe(4);
					expect(options.port).toBe(fixture.port);
					return request({ ...options, ca: fixture.certificate }, callback);
				},
				policy,
			);
			expect(
				(await transport.send(`${origin}/events`, "{}", {}, 2000)).status,
			).toBe(204);
		}
		expect(hosts).toEqual(Array(3).fill(`receiver.example:${fixture.port}`));
		expect(fixture.sni).toEqual(Array(3).fill("receiver.example"));
		expect(connected).toBe(3);
		const untrusted = new WebhookTransport(
			[],
			async () => [{ address: "127.0.0.1", family: 4 }],
			undefined,
			policy,
		);
		await expect(untrusted.send(origin, "{}", {}, 2000)).rejects.toThrow();
		expect(hosts).toHaveLength(3);
	} finally {
		await fixture.close();
	}
});

test("private exceptions constrain every DNS answer, exact origin/port and the global origin allowlist", async () => {
	let requests = 0;
	const fixture = await webhookTlsFixture((_incoming, response) => {
		requests++;
		response.writeHead(204).end();
	});
	const origin = `https://receiver.example:${fixture.port}`;
	const policy = [{ origin, cidrs: ["127.0.0.1/32"] }];
	let addresses = [{ address: "127.0.0.1", family: 4 }];
	let connections = 0;
	const connect: ConstructorParameters<typeof WebhookTransport>[2] = (
		options,
		callback,
	) => {
		connections++;
		expect(options.hostname).toBe("127.0.0.1");
		return request({ ...options, ca: fixture.certificate }, callback);
	};
	const transport = new WebhookTransport(
		[],
		async () => addresses,
		connect,
		policy,
	);
	try {
		expect((await transport.send(origin, "{}", {}, 2000)).status).toBe(204);
		for (const changed of [
			[{ address: "127.0.0.2", family: 4 }],
			[{ address: "::ffff:127.0.0.2", family: 6 }],
			[{ address: "93.184.216.34", family: 4 }],
			[{ address: "::1", family: 6 }],
			[
				{ address: "127.0.0.1", family: 4 },
				{ address: "10.0.0.1", family: 4 },
			],
		]) {
			addresses = changed;
			await expect(
				transport.send(origin, "{}", {}, 2000),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		addresses = [{ address: "127.0.0.1", family: 4 }];
		for (const target of [
			`https://other.example:${fixture.port}`,
			`https://receiver.example:${fixture.port === 65535 ? 65534 : fixture.port + 1}`,
		])
			await expect(
				transport.send(target, "{}", {}, 2000),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		const restricted = new WebhookTransport(
			["https://other.example"],
			async () => addresses,
			connect,
			policy,
		);
		await expect(restricted.send(origin, "{}", {}, 2000)).rejects.toMatchObject(
			{ code: "INVALID_REQUEST" },
		);
		const defaultPolicy = new WebhookTransport(
			[],
			async () => addresses,
			connect,
		);
		await expect(
			defaultPolicy.send(origin, "{}", {}, 2000),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		policy[0]?.cidrs.push("10.0.0.0/8");
		addresses = [{ address: "10.0.0.1", family: 4 }];
		await expect(transport.send(origin, "{}", {}, 2000)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(requests).toBe(1);
		expect(connections).toBe(1);
	} finally {
		await fixture.close();
	}
});

test("plain HTTP requires its own explicit exact-origin/CIDR exception and refuses redirects", async () => {
	const sockets = new Set<Duplex>();
	let requests = 0;
	let host: string | undefined;
	const server = createServer((incoming, response) => {
		requests++;
		host = incoming.headers.host;
		response.writeHead(302, { location: "/redirect-target" }).end();
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing HTTP fixture address");
	const origin = `http://127.0.0.1:${address.port}`;
	try {
		expect(() => new WebhookTransport().url(origin)).toThrow();
		expect(() =>
			new WebhookTransport().url(`https://127.0.0.1:${address.port}`),
		).toThrow();
		const transport = new WebhookTransport([], undefined, undefined, [
			{ origin, cidrs: ["127.0.0.1/32"] },
		]);
		expect(await transport.send(`${origin}/events`, "{}", {}, 2000)).toEqual({
			status: 302,
			retryAfter: null,
		});
		expect(requests).toBe(1);
		expect(host).toBe(`127.0.0.1:${address.port}`);
		expect(() => transport.url(`http://127.0.0.2:${address.port}`)).toThrow();
		expect(() =>
			transport.url(
				`http://127.0.0.1:${address.port === 65535 ? 65534 : address.port + 1}`,
			),
		).toThrow();
		const wrongRange = new WebhookTransport([], undefined, undefined, [
			{ origin, cidrs: ["127.0.0.2/32"] },
		]);
		expect(() => wrongRange.url(origin)).toThrow();
		const mapped = `http://[::ffff:127.0.0.1]:${address.port}`;
		const mappedTransport = new WebhookTransport([], undefined, undefined, [
			{ origin: mapped, cidrs: ["127.0.0.1/32"] },
		]);
		expect((await mappedTransport.send(mapped, "{}", {}, 2000)).status).toBe(
			302,
		);
		expect(requests).toBe(2);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
