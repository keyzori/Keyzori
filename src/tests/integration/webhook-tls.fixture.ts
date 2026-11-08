import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, request } from "node:https";
import type { RequestListener } from "node:http";
import type { Duplex } from "node:stream";
import type { LookupAddress } from "node:dns";
import { WebhookTransport } from "../../plugins/webhooks/WebhookTransport";

/** Ephemeral, self-signed certificates: no checked-in private keys or external tools. */
export function webhookCertificate(host = "receiver.example") {
	const der = (tag: number, ...parts: Buffer[]): Buffer => {
		const value = Buffer.concat(parts);
		const length =
			value.length < 128
				? Buffer.from([value.length])
				: value.length < 256
					? Buffer.from([0x81, value.length])
					: Buffer.from([0x82, value.length >> 8, value.length & 255]);
		return Buffer.concat([Buffer.from([tag]), length, value]);
	};
	const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
	const algorithm = sequence(Buffer.from("06092a864886f70d01010b0500", "hex"));
	const name = sequence(
		der(
			0x31,
			sequence(Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from(host))),
		),
	);
	const time = (date: Date) =>
		der(
			0x17,
			Buffer.from(
				`${date.toISOString().slice(2, 19).replaceAll(/[-:T]/g, "")}Z`,
			),
		);
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const serial = randomBytes(16);
	serial[0] = (serial[0] ?? 0) | 0x80;
	const tbs = sequence(
		der(0xa0, der(0x02, Buffer.from([2]))),
		der(0x02, Buffer.concat([Buffer.from([0]), serial])),
		algorithm,
		name,
		sequence(
			time(new Date(Date.now() - 86400000)),
			time(new Date(Date.now() + 2592000000)),
		),
		name,
		publicKey.export({ format: "der", type: "spki" }),
		der(
			0xa3,
			sequence(
				sequence(
					Buffer.from("0603551d13", "hex"),
					der(0x01, Buffer.from([0xff])),
					der(0x04, sequence(der(0x01, Buffer.from([0xff])))),
				),
				sequence(
					Buffer.from("0603551d11", "hex"),
					der(0x04, sequence(der(0x82, Buffer.from(host)))),
				),
			),
		),
	);
	const certificate = sequence(
		tbs,
		algorithm,
		der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)),
	);
	return {
		key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
		cert: `-----BEGIN CERTIFICATE-----\n${certificate
			.toString("base64")
			.match(/.{1,64}/g)
			?.join("\n")}\n-----END CERTIFICATE-----\n`,
	};
}

export async function webhookTlsFixture(
	handler: RequestListener,
	certificate = webhookCertificate(),
) {
	const sni: string[] = [];
	const connections = new Set<Duplex>();
	const server = createServer(certificate, (request, response) => {
		if (
			"servername" in request.socket &&
			typeof request.socket.servername === "string"
		)
			sni.push(request.socket.servername);
		handler(request, response);
	});
	server.on("connection", (socket) => {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing local TLS fixture address");
	const pinned: string[] = [];
	const transport = (
		trusted = true,
		resolve: (host: string) => Promise<LookupAddress[]> = async () => [
			{ address: "93.184.216.34", family: 4 },
		],
	) =>
		new WebhookTransport([], resolve, (options, callback) => {
			pinned.push(String(options.hostname));
			// Route the validated public address to this isolated fixture; retain real TLS verification, SNI and Host.
			return request(
				{
					...options,
					hostname: "127.0.0.1",
					port: address.port,
					...(trusted ? { ca: certificate.cert } : {}),
				},
				callback,
			);
		});
	return {
		port: address.port,
		certificate: certificate.cert,
		sni,
		pinned,
		transport,
		async close() {
			for (const socket of connections) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
