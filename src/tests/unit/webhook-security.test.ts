import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { RequestOptions } from "node:https";
import { WebhookSecrets } from "../../plugins/webhooks/WebhookSecrets";
import {
	WebhookTransport,
	publicWebhookAddress,
} from "../../plugins/webhooks/WebhookTransport";
import { retryDelay } from "../../plugins/webhooks/WebhookDispatcher";
import { eventScope } from "../../core/auth/EventAuthorization";

describe("webhook security boundaries", () => {
	test("rejects local, reserved, mapped and transition addresses", () => {
		for (const address of [
			"0.0.0.0",
			"10.1.1.1",
			"100.64.1.1",
			"127.0.0.1",
			"169.254.169.254",
			"172.16.1.1",
			"192.168.1.1",
			"192.0.2.1",
			"198.18.0.1",
			"224.0.0.1",
			"255.255.255.255",
			"::1",
			"::ffff:127.0.0.1",
			"::ffff:8.8.8.8",
			"fc00::1",
			"fe80::1",
			"2001:db8::1",
			"2002:7f00:1::",
			"64:ff9b::7f00:1",
			"not-an-ip",
		])
			expect(publicWebhookAddress(address)).toBe(false);
		for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])
			expect(publicWebhookAddress(address)).toBe(true);
	});

	test("only exact permitted HTTPS origins without URL credentials are accepted", () => {
		const transport = new WebhookTransport(["https://receiver.example"]);
		expect(transport.url("https://receiver.example/events").href).toBe(
			"https://receiver.example/events",
		);
		for (const url of [
			"http://receiver.example/events",
			"https://receiver.example.attacker.test/",
			"https://user:password@receiver.example/",
			"https://receiver.example/#secret",
			"https://127.1/",
			"https://[::ffff:127.0.0.1]/",
			"https://receiver.example:8443/",
		])
			expect(() => transport.url(url)).toThrow();
	});

	test("DNS rebinding and mixed public/private answers cannot reach the sender", async () => {
		let sent = 0;
		for (const addresses of [
			[{ address: "127.0.0.1", family: 4 }],
			[
				{ address: "93.184.216.34", family: 4 },
				{ address: "::1", family: 6 },
			],
		]) {
			const transport = new WebhookTransport(
				[],
				async () => addresses,
				() => {
					sent++;
					throw new Error("Unexpected send");
				},
			);
			await expect(
				transport.send("https://receiver.example/", "{}", {}, 1000),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(sent).toBe(0);
	});

	test("actual TCP target is the vetted IP while TLS and HTTP retain the receiver identity", async () => {
		let options: RequestOptions | undefined;
		let resolutions = 0;
		const transport = new WebhookTransport(
			[],
			async () => {
				resolutions++;
				return [{ address: "93.184.216.34", family: 4 }];
			},
			(value) => {
				options = value;
				throw new Error("Captured transport");
			},
		);
		await expect(
			transport.send("https://receiver.example:8443/path?q=1", "{}", {}, 1000),
		).rejects.toThrow("Captured transport");
		expect(options).toMatchObject({
			hostname: "93.184.216.34",
			servername: "receiver.example",
			port: 8443,
			path: "/path?q=1",
			agent: false,
			rejectUnauthorized: true,
			headers: { host: "receiver.example:8443" },
		});
		expect(typeof options?.checkServerIdentity).toBe("function");
		expect(resolutions).toBe(1);
	});

	test("secrets encrypt authentically and signatures cover timestamp, delivery ID and exact bytes", () => {
		const secrets = new WebhookSecrets("a".repeat(64));
		const issued = secrets.issue();
		expect(issued.secretCiphertext).not.toContain(issued.secret);
		expect(secrets.decrypt(issued.secretCiphertext)).toBe(issued.secret);
		expect(() =>
			new WebhookSecrets("b".repeat(64)).decrypt(issued.secretCiphertext),
		).toThrow();
		expect(() =>
			secrets.decrypt(`${issued.secretCiphertext.slice(0, -5)}AAAAA`),
		).toThrow();
		expect(() => new WebhookSecrets().issue()).toThrow();
		const body = '{"message":"exact bytes"}';
		const expected = createHmac("sha256", Buffer.from(issued.secret, "hex"))
			.update(`123.delivery.${body}`)
			.digest("hex");
		expect(secrets.sign(issued.secretCiphertext, "123", "delivery", body)).toBe(
			expected,
		);
		expect(
			secrets.sign(issued.secretCiphertext, "124", "delivery", body),
		).not.toBe(expected);
		expect(
			secrets.sign(issued.secretCiphertext, "123", "other", body),
		).not.toBe(expected);
		expect(
			secrets.sign(issued.secretCiphertext, "123", "delivery", `${body}\n`),
		).not.toBe(expected);
	});

	test("cancelling DNS resolution prevents a late answer from opening a connection", async () => {
		const dns = Promise.withResolvers<{ address: string; family: number }[]>();
		const cancellation = new AbortController();
		let connected = false;
		const transport = new WebhookTransport(
			[],
			() => dns.promise,
			() => {
				connected = true;
				throw new Error("Unexpected connection");
			},
		);
		const pending = transport.send(
			"https://receiver.example/",
			"{}",
			{},
			2000,
			cancellation.signal,
		);
		cancellation.abort(new Error("Cancelled DNS"));
		await expect(pending).rejects.toThrow("Cancelled DNS");
		dns.resolve([{ address: "93.184.216.34", family: 4 }]);
		await dns.promise;
		expect(connected).toBe(false);
	});

	test("retry hints are bounded and device/IP events require their own read permissions", () => {
		const now = new Date("2026-11-06T00:00:00Z");
		expect(retryDelay(1, null, now, 0)).toBe(24000);
		expect(retryDelay(1, "120", now, 0)).toBe(120000);
		expect(retryDelay(8, "99999999999", now, 1)).toBe(3600000);
		expect(retryDelay(1, "Fri, 06 Nov 2026 00:02:00 GMT", now, 0)).toBe(120000);
		expect(eventScope("license.hardware.registered")).toBe("devices:read");
		expect(eventScope("license.ips.removed")).toBe("ips:read");
		expect(eventScope("license.unknown")).toBeUndefined();
	});
});
