import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { hardware } from "../../core/database/schema/hardware";
import { ips } from "../../core/database/schema/ips";
import { meters } from "../../core/database/schema/meters";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("validation does not enroll devices or addresses; explicit registration is atomic", async () => {
	const issued = await context.licenses.create(
		{ deviceLimit: 3, ipLimit: 2 },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential, hardwareId: "one" },
				context.operation(),
			)
		).data.code,
	).toBe("DEVICE_NOT_REGISTERED");
	expect(
		await context.database.orm
			.select()
			.from(hardware)
			.where(eq(hardware.licenseId, issued.data.id)),
	).toHaveLength(0);
	const devices = await Promise.allSettled(
		Array.from({ length: 8 }, (_, index) =>
			context.licenses.register(
				{ licenseId: issued.data.id, hardwareId: `device-${index}` },
				context.operation(),
				"device",
			),
		),
	);
	expect(
		devices.filter((result) => result.status === "fulfilled"),
	).toHaveLength(3);
	const addresses = await Promise.allSettled(
		Array.from({ length: 6 }, (_, index) =>
			context.licenses.register(
				{ licenseId: issued.data.id, ip: `192.0.2.${index + 1}` },
				context.operation(),
				"ip",
			),
		),
	);
	expect(
		addresses.filter((result) => result.status === "fulfilled"),
	).toHaveLength(2);
});

test("cap changes preserve observations and explicit removal frees an admission slot", async () => {
	const issued = await context.licenses.create(
		{ deviceLimit: 2, ipLimit: 1 },
		context.operation(),
	);
	await context.licenses.register(
		{ licenseId: issued.data.id, hardwareId: "oldest" },
		context.operation(),
		"device",
	);
	await context.licenses.register(
		{ licenseId: issued.data.id, hardwareId: "newest" },
		context.operation(),
		"device",
	);
	await context.licenses.register(
		{ licenseId: issued.data.id, ip: "127.0.0.1" },
		context.operation(),
		"ip",
	);
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { deviceLimit: 1, ipLimit: null } },
		context.operation(),
	);
	expect(
		await context.database.orm
			.select()
			.from(hardware)
			.where(eq(hardware.licenseId, issued.data.id)),
	).toHaveLength(2);
	expect(
		await context.database.orm
			.select()
			.from(ips)
			.where(eq(ips.licenseId, issued.data.id)),
	).toHaveLength(1);
	await expect(
		context.licenses.register(
			{ licenseId: issued.data.id, hardwareId: "third" },
			context.operation(),
			"device",
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await context.licenses.removeHardware(
		{ ids: [issued.data.id], hardwareIds: ["oldest", "newest"] },
		context.operation(),
	);
	await context.licenses.register(
		{ licenseId: issued.data.id, hardwareId: "third" },
		context.operation(),
		"device",
	);
});

test("zero caps reject enrollment and runtime policies still apply to consumption", async () => {
	const issued = await context.licenses.create(
		{ deviceLimit: 0, meters: { upsert: [{ name: "uses" }] } },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	await expect(
		context.licenses.register(
			{ licenseId: issued.data.id, hardwareId: "zero" },
			context.operation(),
			"device",
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await expect(
		context.licenses.consume(
			{ licenseId: issued.data.id, hardwareId: "zero", usage: { uses: "1" } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("0");
});

test("group disable waits for an admitted validation and gates later validation", async () => {
	const group = await context.groups.create(
		{ name: "Locking" },
		context.operation(),
	);
	await context.groups.enable({ ids: [group.data.id] }, context.operation());
	const issued = await context.licenses.create(
		{ groupId: group.data.id },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const original = context.ip.matches.bind(context.ip);
	const hook = spyOn(context.ip, "matches").mockImplementationOnce(
		async (...args) => {
			held.resolve();
			await release.promise;
			return original(...args);
		},
	);
	try {
		const first = context.validation.validate(
			{ license: issued.credential },
			context.operation(),
		);
		await held.promise;
		let disabled = false;
		const disable = context.groups
			.disable({ ids: [group.data.id] }, context.operation())
			.then(() => {
				disabled = true;
			});
		await Bun.sleep(30);
		expect(disabled).toBe(false);
		release.resolve();
		expect((await first).data.valid).toBe(true);
		await disable;
		expect(
			(
				await context.validation.validate(
					{ license: issued.credential },
					context.operation(),
				)
			).data.code,
		).toBe("GROUP_DISABLED");
	} finally {
		release.resolve();
		hook.mockRestore();
	}
});

test("precision reduction cannot silently discard exact accepted usage", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "decimal",
						limit: "10.99",
						numericMode: "decimal",
						precision: 2,
					},
				],
			},
		},
		context.operation(),
	);
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "decimal", action: "set", value: "1.25" },
		context.operation(),
	);
	await expect(
		context.licenses.update(
			{
				ids: [issued.data.id],
				changes: {
					meters: {
						upsert: [{ name: "decimal", numericMode: "integer", limit: "10" }],
					},
				},
			},
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("1.25");
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "decimal", action: "decrement", value: "2" },
		context.operation(),
	);
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("0");
});
