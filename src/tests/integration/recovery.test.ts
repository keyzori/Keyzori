import { expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { MigrationService } from "../../core/database/MigrationService";
import { RestoreService } from "../../core/database/RestoreService";
import { Database } from "../../core/database/Database";
import { eventState } from "../../core/database/schema/events";
import { deliveries } from "../../core/database/schema/deliveries";
import { webhooks } from "../../core/database/schema/webhooks";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { WebhookSecrets } from "../../plugins/webhooks/WebhookSecrets";
import { WebhookDispatcher } from "../../plugins/webhooks/WebhookDispatcher";
import { WebhookTransport } from "../../plugins/webhooks/WebhookTransport";
import { WebhookService } from "../../plugins/webhooks/WebhookService";
import { IdempotencyService } from "../../core/security/IdempotencyService";
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
	const run = Bun.env.KZ_TEST_RUN_ID;
	if (
		!run ||
		!/^[a-f0-9-]{36}$/.test(run) ||
		url.hostname !== "127.0.0.1" ||
		!/^\/keyzori_test_[a-f0-9]+$/.test(url.pathname)
	)
		throw new Error("Recovery drills require a project disposable database");
	const ids = new TextDecoder()
		.decode(
			await docker([
				"ps",
				"--filter",
				`label=dev.keyzori.test-run=${run}`,
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
			role?: string,
		) => {
			if (
				!/^keyzori_test_[a-f0-9]+$/.test(database) ||
				(role && !/^kz_owner_[a-f0-9]{32}$/.test(role))
			)
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
					...(role ? [`--role=${role}`] : []),
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

test("a logical restore detects stripped privileges, fences pending sends, and replays only after explicit review", async () => {
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
	let dispatcher: WebhookDispatcher | undefined;
	const connections: Database[] = [];
	try {
		const sourceRoles = await source.fixture.startWithRoles();
		const targetRoles = await restored.fixture.startWithRoles();
		const sourceMigration = new Database(sourceRoles.migrationUrl, 1);
		const targetMigration = new Database(targetRoles.migrationUrl, 1);
		const runtime = new Database(targetRoles.runtimeUrl, 2);
		connections.push(sourceMigration, targetMigration, runtime);
		await new MigrationService(sourceMigration).run();
		await source.redis.connect();
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
			enabled: true,
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
		const owner = new URL(targetRoles.migrationUrl).username;
		const target = sql.identifier(targetUrl.pathname.slice(1));
		// The target database is newly created and empty. Let the archive create
		// its own drizzle schema, with the correct target owner but WITHOUT ACLs.
		await restored.database.client`drop schema drizzle`;
		await restored.database.orm.execute(
			sql`grant create on database ${target} to ${sql.identifier(owner)}`,
		);
		await client("pg_restore", targetUrl.pathname.slice(1), backup, owner);
		await restored.database.orm.execute(
			sql`revoke create on database ${target} from ${sql.identifier(owner)}`,
		);
		expect(await new MigrationService(restored.database).verify()).toEqual(
			await new MigrationService(source.database).verify(),
		);
		const [before] = await restored.database.orm.select().from(eventState);
		expect(before?.epoch).toBe(checkpoint.data.epoch);
		expect(
			(
				await restored.database
					.client`select has_table_privilege('keyzori_server','audit_logs','UPDATE') as mutable`
			)[0]?.mutable,
		).toBe(true);
		await expect(
			new RestoreService(targetMigration).prepare(),
		).rejects.toMatchObject({ code: "RUNTIME_ROLE_REQUIRED" });
		expect(
			(await restored.database.orm.select().from(eventState))[0]?.epoch,
		).toBe(before?.epoch);
		// Explicit owner provisioning restores the canonical evidence/journal ACLs;
		// neither serving nor restore preparation silently reconciles permissions.
		await new MigrationService(targetMigration).run();
		await new MigrationService(runtime).verifyRuntime();
		const epoch = await new RestoreService(targetMigration).prepare();
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
		expect(pending?.state).toBe("cancelled");
		expect(pending?.attempts).toBe(0);
		expect(sent).not.toHaveBeenCalled();
		expect(pending?.secretCiphertext).toBeNull();
		const [hook] = await runtime.orm
			.select()
			.from(webhooks)
			.where(eq(webhooks.id, webhookId));
		if (!hook) throw new Error("Restored webhook missing");
		expect(hook.enabled).toBe(false);
		expect(() =>
			new WebhookSecrets("e".repeat(64)).decrypt(hook.secretCiphertext),
		).toThrow();
		expect(secrets.decrypt(hook.secretCiphertext)).toBe(issued.secret);
		dispatcher = new WebhookDispatcher(
			runtime,
			restored.settings,
			undefined,
			restored.auth,
			encryptionKey,
		);
		await dispatcher.runOnce();
		expect(sent).not.toHaveBeenCalled();
		const service = new WebhookService(
			runtime,
			restored.auth,
			restored.audit,
			restored.settings,
			new IdempotencyService(runtime, restored.settings, restored.auth),
			{ encryptionKey },
		);
		await service.enable({ ids: [webhookId] }, restored.operation());
		const reviewed = await service.replay(
			{ ids: [deliveryId], confirm: true, reason: "Reviewed restored work" },
			restored.operation(),
		);
		const replayId = reviewed.data[0]?.id;
		if (!replayId || replayId === deliveryId)
			throw new Error("Expected distinct replay identity");
		await dispatcher.runOnce();
		expect(sent).toHaveBeenCalledTimes(1);
		const call = sent.mock.calls[0];
		if (!call) throw new Error("Restored webhook was not sent");
		const [, body, headers] = call;
		expect(headers["X-Keyzori-Delivery-Id"]).toBe(replayId);
		expect(headers["X-Keyzori-Signing-Key-Id"]).toBe(issued.signingKeyId);
		expect(headers["X-Keyzori-Signature"]).toBe(
			`v1=${createHmac("sha256", Buffer.from(issued.secret, "hex")).update(`${headers["X-Keyzori-Timestamp"]}.${replayId}.${body}`).digest("hex")}`,
		);
		expect(
			(
				await restored.database.orm
					.select()
					.from(deliveries)
					.where(eq(deliveries.id, replayId))
			)[0]?.state,
		).toBe("succeeded");
	} finally {
		dispatcher?.stop();
		await dispatcher?.drain();
		sent.mockRestore();
		sourceActivity.stop();
		restoredActivity.stop();
		await Promise.all(connections.map((db) => db.close()));
		await Promise.all([source.stop(), restored.stop()]);
	}
}, 60000);
