import assert from "node:assert/strict";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "../../core/database/Database";
import { deliveries } from "../../core/database/schema/deliveries";
import { licenses } from "../../core/database/schema/licenses";
import { meters } from "../../core/database/schema/meters";
import { receipts } from "../../core/database/schema/receipts";
import { webhooks } from "../../core/database/schema/webhooks";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { SecretHasher } from "../../core/security/SecretHasher";

export class ArtifactRuntimeContract {
	private readonly listeners: Bun.Server<undefined>[] = [];
	private readonly drainStarted = Promise.withResolvers<void>();
	private readonly drainReleased = Promise.withResolvers<void>();
	private trustedRequests = 0;
	private untrustedRequests = 0;
	private trustedUrl = "";
	private untrustedUrl = "";
	private drainDelivery: string | undefined;
	constructor(private readonly database: Database) {}

	async prepare(directory: string, hostname = "127.0.0.1") {
		const openssl =
			Bun.which("openssl") ??
			join(
				Bun.env.ProgramFiles ?? "C:\\Program Files",
				"Git/usr/bin/openssl.exe",
			);
		if (!(await Bun.file(openssl).exists()))
			throw new Error("OpenSSL is required for local artifact TLS fixtures");
		for (const name of ["trusted", "untrusted"]) {
			const certificate = join(directory, `${name}.pem`);
			const key = join(directory, `${name}.key`);
			const generation = Bun.spawn(
				[
					openssl,
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-sha256",
					"-nodes",
					"-days",
					"1",
					"-keyout",
					key,
					"-out",
					certificate,
					"-subj",
					`/CN=Keyzori ${name} artifact fixture`,
					"-addext",
					"subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1",
					"-addext",
					"basicConstraints=critical,CA:TRUE",
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
			assert.equal(
				await generation.exited,
				0,
				"Fixture certificate generation failed",
			);
			const listener = Bun.serve({
				hostname: hostname === "127.0.0.1" ? hostname : "0.0.0.0",
				port: 0,
				tls: { key: Bun.file(key), cert: Bun.file(certificate) },
				fetch: async (request) => {
					assert.equal(request.method, "POST");
					await request.json();
					if (name === "untrusted") this.untrustedRequests++;
					else if (new URL(request.url).pathname === "/drain") {
						this.drainStarted.resolve();
						await this.drainReleased.promise;
					} else this.trustedRequests++;
					return new Response(null, { status: 204 });
				},
			});
			this.listeners.push(listener);
			const url = `https://${hostname}:${listener.port}`;
			if (name === "trusted") this.trustedUrl = url;
			else this.untrustedUrl = url;
		}
		return join(directory, "trusted.pem");
	}

	async run() {
		const trusted = await this.enqueue(this.trustedUrl);
		const untrusted = await this.enqueue(this.untrustedUrl);
		const trustedResult = await this.delivery(trusted);
		const untrustedResult = await this.delivery(untrusted);
		assert.equal(
			trustedResult.state,
			"succeeded",
			"Trusted TLS webhook failed",
		);
		assert.equal(trustedResult.status, 204);
		assert.equal(trustedResult.error, null);
		assert.equal(this.trustedRequests, 1);
		assert.equal(
			untrustedResult.state,
			"failed",
			"Untrusted TLS webhook was accepted",
		);
		assert.equal(untrustedResult.status, null);
		assert.equal(untrustedResult.error, "transport");
		assert.equal(this.untrustedRequests, 0);
		await this.cron();
	}

	private async cron() {
		const id = Bun.randomUUIDv7();
		const past = new Date(Date.now() - 86400000);
		await this.database.transaction(async (tx) => {
			await tx.insert(licenses).values({
				id,
				keyHash: new SecretHasher().hash(id),
				enabled: true,
				keyFormat: KeyGenerator.defaultFormat,
				createdBy: "artifact-fixture",
				updatedBy: "artifact-fixture",
			});
			await tx.insert(meters).values({
				id,
				licenseId: id,
				name: "cron-fixture",
				value: "7",
				limit: "10",
				schedule: {
					interval: "day",
					time: "00:00",
					timezone: "Australia/Sydney",
				},
				nextResetAt: past,
			});
			await tx.insert(receipts).values({
				operation: "artifact.cron",
				principalId: "artifact-fixture",
				key: id,
				fingerprint: id,
				expiresAt: past,
			});
		});
		const deadline = Date.now() + 70000;
		while (Date.now() < deadline) {
			const [meter] = await this.database.orm
				.select()
				.from(meters)
				.where(eq(meters.id, id));
			const [receipt] = await this.database.orm
				.select()
				.from(receipts)
				.where(eq(receipts.key, id));
			if (meter?.lastResetAt && !receipt) {
				assert.equal(meter.value, "0");
				assert.ok(meter.lastScheduledResetAt);
				assert.ok(meter.nextResetAt && meter.nextResetAt > meter.lastResetAt);
				return;
			}
			await Bun.sleep(250);
		}
		throw new Error(
			"Artifact cron did not reset its overdue meter and remove its expired receipt within its scheduled window",
		);
	}

	private async enqueue(url: string) {
		const id = Bun.randomUUIDv7();
		await this.database.transaction(async (tx) => {
			await tx.insert(webhooks).values({
				id,
				url,
				events: ["license.created"],
				enabled: true,
				createdBy: "artifact-fixture",
				updatedBy: "artifact-fixture",
			});
			await tx.insert(deliveries).values({
				id,
				webhookId: id,
				payload: {
					id,
					event: "license.created",
					createdAt: new Date().toISOString(),
					data: {},
				},
			});
		});
		return id;
	}

	private async delivery(id: string) {
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const [row] = await this.database.orm
				.select()
				.from(deliveries)
				.where(eq(deliveries.id, id));
			if (row && row.state !== "pending" && row.state !== "claimed") return row;
			await Bun.sleep(50);
		}
		throw new Error("Artifact webhook did not settle");
	}

	async prepareShutdown() {
		this.drainDelivery = await this.enqueue(`${this.trustedUrl}/drain`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.drainStarted.promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Drain probe did not start")),
						15000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	releaseShutdown() {
		this.drainReleased.resolve();
	}
	async verifyShutdown() {
		assert.ok(this.drainDelivery);
		const [row] = await this.database.orm
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, this.drainDelivery));
		assert.equal(
			row?.state,
			"succeeded",
			"Shutdown did not finish its in-flight webhook",
		);
		assert.equal(row.status, 204);
	}
	async close() {
		this.releaseShutdown();
		await Promise.all(this.listeners.map((listener) => listener.stop(true)));
	}
}
