import { expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { MigrationService } from "../../core/database/MigrationService";
import { eventState } from "../../core/database/schema/events";
import { deliveries } from "../../core/database/schema/deliveries";
import { webhooks } from "../../core/database/schema/webhooks";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { WebhookSecrets } from "../../plugins/webhooks/WebhookSecrets";
import { WebhookDispatcher } from "../../plugins/webhooks/WebhookDispatcher";
import { WebhookTransport } from "../../plugins/webhooks/WebhookTransport";
import { TestContext } from "../fixtures/TestContext";

async function docker(args: string[], password = "", input?: Uint8Array) {
	const process = Bun.spawn(["docker", ...args], {
		env: { ...Bun.env, PGPASSWORD: password },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => process.kill("SIGTERM"), 30000);
	try {
		if (input) process.stdin.write(input);
		process.stdin.end();
		const [code, output] = await Promise.all([
			process.exited,
			new Response(process.stdout).arrayBuffer(),
			new Response(process.stderr).text(),
		]);
		if (code !== 0) throw new Error("Disposable recovery client failed");
		return new Uint8Array(output);
	} finally {
		clearTimeout(timer);
	}
}

/** Only exec pg_dump/restore inside the project fixture container owning this exact port. */
async function fixtureClient(url: URL) {
	if (
		url.hostname !== "127.0.0.1" ||
		!/^\/keyzori_test_[a-f0-9]+$/.test(url.pathname)
	)
		throw new Error("Recovery drills require a project disposable database");
	const ids = new TextDecoder()
		.decode(
			await docker([
				"ps",
				"--filter",
				"label=dev.keyzori.test-run",
				"--format",
				"{{.ID}}",
			]),
		)
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	for (const id of ids) {
		if (!/^[a-f0-9]+$/.test(id))
			throw new Error("Invalid disposable container identity");
		const ports: unknown = JSON.parse(
			new TextDecoder().decode(
				await docker([
					"inspect",
					"--format",
					"{{json .NetworkSettings.Ports}}",
					id,
				]),
			),
		);
		if (!ports || typeof ports !== "object" || !("5432/tcp" in ports)) continue;
		const bindings = ports["5432/tcp"];
		if (
			!Array.isArray(bindings) ||
			!bindings.some(
				(binding) =>
					binding?.HostIp === "127.0.0.1" && binding?.HostPort === url.port,
			)
		)
			continue;
		return (
			command: "pg_dump" | "pg_restore",
			database: string,
			input?: Uint8Array,
		) => {
			if (!/^keyzori_test_[a-f0-9]+$/.test(database))
				throw new Error("Invalid disposable restore target");
			return docker(
				[
					"exec",
					"-i",
					"-e",
					"PGPASSWORD",
					id,
					command,
					"--host=127.0.0.1",
					`--username=${decodeURIComponent(url.username)}`,
					"--no-owner",
					"--no-privileges",
					...(command === "pg_dump"
						? ["--format=custom"]
						: ["--exit-on-error", "--single-transaction"]),
					`--dbname=${database}`,
				],
				decodeURIComponent(url.password),
				input,
			);
		};
	}
	throw new Error(
		"No owned project PostgreSQL fixture matched the restore drill",
	);
}

test("a real disposable backup restores history, rejects old stream cursors and resumes signed pending work only explicitly", async () => {
	const source = new TestContext();
	const restored = new TestContext();
	const sourceActivity = new ActivityService(
		source.database,
		source.auth,
		source.redis,
	);
	const restoredActivity = new ActivityService(
		restored.database,
		restored.auth,
		restored.redis,
	);
	const encryptionKey = "d".repeat(64);
	const secrets = new WebhookSecrets(encryptionKey);
	const issued = secrets.issue();
	const sent = spyOn(WebhookTransport.prototype, "send").mockResolvedValue({
		status: 204,
		retryAfter: null,
	});
	const dispatcher = new WebhookDispatcher(
		restored.database,
		restored.settings,
		undefined,
		restored.auth,
		encryptionKey,
	);
	try {
		await source.start();
		await restored.fixture.start(false);
		await restored.redis.connect();
		await source.licenses.create({}, source.operation());
		await sourceActivity.publish();
		const checkpoint = await sourceActivity.watermark(source.operation());
		const webhookId = Bun.randomUUIDv7();
		const deliveryId = Bun.randomUUIDv7();
		const eventId = Bun.randomUUIDv7();
		const licenseId = Bun.randomUUIDv7();
		await source.database.orm.insert(webhooks).values({
			id: webhookId,
			url: "https://receiver.example/restore",
			events: ["license.created"],
			allGroups: true,
			secretCiphertext: issued.secretCiphertext,
			signingKeyId: issued.signingKeyId,
			enabled: false,
			lastSequence: BigInt(checkpoint.data.sequence),
			createdBy: "root",
			updatedBy: "root",
		});
		await source.database.orm.insert(deliveries).values({
			id: deliveryId,
			webhookId,
			eventId,
			groupId: null,
			global: false,
			endpointVersion: 1,
			url: "https://receiver.example/restore",
			secretCiphertext: issued.secretCiphertext,
			signingKeyId: issued.signingKeyId,
			payload: {
				schemaVersion: 1,
				id: eventId,
				event: "license.created",
				createdAt: new Date().toISOString(),
				resource: { type: "license", id: licenseId, revision: "1" },
				data: { licenseId, groupId: null },
			},
			expiresAt: new Date(Date.now() + 3600000),
			state: "pending",
		});
		const sourceUrl = new URL(source.fixture.url);
		const targetUrl = new URL(restored.fixture.url);
		expect(targetUrl.host).toBe(sourceUrl.host);
		const client = await fixtureClient(sourceUrl);
		const backup = await client("pg_dump", sourceUrl.pathname.slice(1));
		expect(backup.byteLength).toBeGreaterThan(0);
		await client("pg_restore", targetUrl.pathname.slice(1), backup);
		expect(await new MigrationService(restored.database).verify()).toEqual(
			await new MigrationService(source.database).verify(),
		);
		const [before] = await restored.database.orm.select().from(eventState);
		expect(before?.epoch).toBe(checkpoint.data.epoch);
		const epoch = await restoredActivity.resetEpoch();
		expect(epoch.epoch).not.toBe(checkpoint.data.epoch);
		expect(epoch.sequence).toBe(checkpoint.data.sequence);
		await expect(
			restoredActivity.read(
				new URLSearchParams({ cursor: checkpoint.data.cursor }),
				restored.operation(),
			),
		).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
		const [pending] = await restored.database.orm
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, deliveryId));
		expect(pending?.state).toBe("pending");
		expect(pending?.attempts).toBe(0);
		expect(sent).not.toHaveBeenCalled();
		if (!pending) throw new Error("Restored delivery missing");
		expect(() =>
			new WebhookSecrets("e".repeat(64)).decrypt(pending.secretCiphertext),
		).toThrow();
		expect(secrets.decrypt(pending.secretCiphertext)).toBe(issued.secret);
		// The dispatcher has not been running during verification or epoch repair.
		await restored.database.orm
			.update(webhooks)
			.set({ enabled: true })
			.where(eq(webhooks.id, webhookId));
		await dispatcher.runOnce();
		expect(sent).toHaveBeenCalledTimes(1);
		const call = sent.mock.calls[0];
		if (!call) throw new Error("Restored webhook was not sent");
		const [, body, headers] = call;
		expect(headers["X-Keyzori-Delivery-Id"]).toBe(deliveryId);
		expect(headers["X-Keyzori-Signing-Key-Id"]).toBe(issued.signingKeyId);
		expect(headers["X-Keyzori-Signature"]).toBe(
			`v1=${createHmac("sha256", Buffer.from(issued.secret, "hex")).update(`${headers["X-Keyzori-Timestamp"]}.${deliveryId}.${body}`).digest("hex")}`,
		);
		expect(
			(
				await restored.database.orm
					.select()
					.from(deliveries)
					.where(eq(deliveries.id, deliveryId))
			)[0]?.state,
		).toBe("succeeded");
	} finally {
		dispatcher.stop();
		await dispatcher.drain();
		sent.mockRestore();
		sourceActivity.stop();
		restoredActivity.stop();
		await Promise.all([source.stop(), restored.stop()]);
	}
}, 60000);
