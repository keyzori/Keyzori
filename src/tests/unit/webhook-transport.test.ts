import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	webhookCertificate,
	webhookTlsFixture,
} from "../integration/webhook-tls.fixture";
import { WebhookSecrets } from "../../plugins/webhooks/WebhookSecrets";

test("real TLS preserves hostname/SNI, Host, exact signed bytes and a pinned DNS address", async () => {
	const secret = new WebhookSecrets("b".repeat(64));
	const issued = secret.issue();
	const body = '{"unicode":"雪", "spacing":true}\n';
	const received = Promise.withResolvers<{
		host: string | undefined;
		body: string;
		signature: string | string[] | undefined;
	}>();
	const fixture = await webhookTlsFixture(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		received.resolve({
			host: request.headers.host,
			body: Buffer.concat(chunks).toString(),
			signature: request.headers["x-keyzori-signature"],
		});
		response.writeHead(204).end();
	});
	try {
		const signature = secret.sign(
			issued.secretCiphertext,
			"123",
			"delivery",
			body,
		);
		expect(
			await fixture
				.transport()
				.send(
					"https://receiver.example:8443/events?q=1",
					body,
					{ "X-Keyzori-Signature": `v1=${signature}` },
					2000,
				),
		).toEqual({ status: 204, retryAfter: null });
		const request = await received.promise;
		expect(request).toEqual({
			host: "receiver.example:8443",
			body,
			signature: `v1=${createHmac("sha256", Buffer.from(issued.secret, "hex")).update(`123.delivery.${request.body}`).digest("hex")}`,
		});
		expect(fixture.sni).toEqual(["receiver.example"]);
		expect(fixture.pinned).toEqual(["93.184.216.34"]);
	} finally {
		await fixture.close();
	}
});

test("real TLS rejects both untrusted certificates and a trusted wrong hostname", async () => {
	let received = 0;
	for (const wrongHostname of [false, true]) {
		const fixture = await webhookTlsFixture(
			(_request, response) => {
				received++;
				response.writeHead(204).end();
			},
			webhookCertificate(wrongHostname ? "wrong.example" : "receiver.example"),
		);
		try {
			await expect(
				fixture
					.transport(wrongHostname)
					.send("https://receiver.example/", "{}", {}, 2000),
			).rejects.toThrow();
		} finally {
			await fixture.close();
		}
	}
	expect(received).toBe(0);
});

test("real transport revalidates changed DNS answers on every attempt and refuses redirects", async () => {
	let received = 0;
	let resolutions = 0;
	const fixture = await webhookTlsFixture((_request, response) => {
		received++;
		response
			.writeHead(302, {
				location: "https://receiver.example/redirect-target",
				"retry-after": "120",
			})
			.end();
	});
	try {
		const transport = fixture.transport(true, async () => [
			{
				address: ++resolutions === 1 ? "93.184.216.34" : "127.0.0.1",
				family: 4,
			},
		]);
		expect(
			await transport.send("https://receiver.example/", "{}", {}, 2000),
		).toEqual({ status: 302, retryAfter: "120" });
		await expect(
			transport.send("https://receiver.example/", "{}", {}, 2000),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(received).toBe(1);
		expect(resolutions).toBe(2);
		expect(fixture.pinned).toEqual(["93.184.216.34"]);
	} finally {
		await fixture.close();
	}
});

test("real transport deadlines and cancellation close stalled requests", async () => {
	for (const cancel of [false, true]) {
		const entered = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const fixture = await webhookTlsFixture((request) => {
			request.socket.once("close", () => closed.resolve());
			entered.resolve();
		});
		try {
			const controller = new AbortController();
			const startedAt = performance.now();
			const result = fixture
				.transport()
				.send(
					"https://receiver.example/",
					"{}",
					{},
					cancel ? 2000 : 150,
					controller.signal,
				);
			const outcome = result.then(
				() => undefined,
				(error: unknown) => error,
			);
			await entered.promise;
			if (cancel) controller.abort();
			expect(await outcome).toBeInstanceOf(Error);
			expect(performance.now() - startedAt).toBeLessThan(1000);
			await Promise.race([
				closed.promise,
				Bun.sleep(1000).then(() => {
					throw new Error("TLS socket remained open");
				}),
			]);
		} finally {
			await fixture.close();
		}
	}
});

test("a streaming response is discarded without waiting for an unbounded body", async () => {
	const closed = Promise.withResolvers<void>();
	const fixture = await webhookTlsFixture((request, response) => {
		request.socket.once("close", () => closed.resolve());
		response.writeHead(200);
		response.write("unbounded receiver content");
	});
	try {
		expect(
			(
				await fixture
					.transport()
					.send("https://receiver.example/", "{}", {}, 2000)
			).status,
		).toBe(200);
		await Promise.race([
			closed.promise,
			Bun.sleep(1000).then(() => {
				throw new Error("Response was not discarded");
			}),
		]);
	} finally {
		await fixture.close();
	}
});
