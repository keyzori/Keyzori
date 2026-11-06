import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { apiKeys } from "../../core/database/schema/apiKeys";
import { groups } from "../../core/database/schema/groups";
import { TestContext } from "../fixtures/TestContext";
import { KeyGenerator } from "../../core/security/KeyGenerator";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

async function key() {
	const issued = await context.apiKeys.create(
		{ name: "Scoped integration" },
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [issued.data.id] }, context.operation());
	return issued;
}

test("API credential rotation never reissues the current secret and bounds generator failure", async () => {
	const issued = await key();
	const originalSecret = issued.credential.split("_").at(-1);
	if (!originalSecret) throw new Error("Missing generated credential");
	const original = { credential: issued.credential, secret: originalSecret };
	const fresh = new KeyGenerator().api(issued.data.id);
	const repeat = spyOn(KeyGenerator.prototype, "api").mockReturnValue(original);
	try {
		await expect(
			context.apiKeys.rotate({ ids: [issued.data.id] }, context.operation()),
		).rejects.toThrow("collision limit");
		expect(repeat).toHaveBeenCalledTimes(5);
		expect(
			(await context.auth.authenticate(`Bearer ${issued.credential}`)).id,
		).toBe(issued.data.id);
		repeat.mockReset().mockReturnValueOnce(original).mockReturnValueOnce(fresh);
		const rotated = await context.apiKeys.rotate(
			{ ids: [issued.data.id] },
			context.operation(),
		);
		expect(rotated.data[0]?.credential).toBe(fresh.credential);
		await expect(
			context.auth.authenticate(`Bearer ${issued.credential}`),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(
			(await context.auth.authenticate(`Bearer ${fresh.credential}`)).id,
		).toBe(issued.data.id);
	} finally {
		repeat.mockRestore();
	}
});

test("new API keys have no authority and cannot elevate themselves", async () => {
	const issued = await key();
	expect(issued.data).toMatchObject({
		scopes: [],
		groupIds: [],
		allGroups: false,
		enabled: false,
	});
	const principal = await context.auth.authenticate(
		`Bearer ${issued.credential}`,
	);
	expect(() => context.auth.require(principal, "licenses:read")).toThrow();
	await expect(
		context.apiKeys.update(
			{
				ids: [issued.data.id],
				changes: { scopes: ["licenses:*"], allGroups: true },
			},
			{ ...context.operation(), principal },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		context.apiKeys.create(
			{ name: "Escalation" },
			{ ...context.operation(), principal },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("grant revocation waits for an authorized mutation and rejects later work from the admitted principal", async () => {
	const issued = await key();
	await context.apiKeys.update(
		{
			ids: [issued.data.id],
			changes: { scopes: ["licenses:update"], allGroups: true },
		},
		context.operation(),
	);
	const principal = await context.auth.authenticate(
		`Bearer ${issued.credential}`,
	);
	const license = await context.licenses.create({}, context.operation());
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const original = context.events.emitChecked;
	context.events.emitChecked = async (...args) => {
		const data = args[2];
		if (
			args[1] === "license.updated" &&
			data &&
			typeof data === "object" &&
			"licenseId" in data &&
			data.licenseId === license.data.id
		) {
			entered.resolve();
			await release.promise;
		}
		return original.apply(context.events, args);
	};
	const mutation = context.licenses.update(
		{
			ids: [license.data.id],
			changes: { notes: "Authorized before revocation" },
		},
		{ ...context.operation(), principal },
	);
	let revocation: Promise<unknown> | undefined;
	try {
		await entered.promise;
		revocation = context.apiKeys.update(
			{ ids: [issued.data.id], changes: { scopes: [] } },
			context.operation(),
		);
		const deadline = Date.now() + 2000;
		let blocked = false;
		while (Date.now() < deadline) {
			const [row] = await context.database
				.client`select exists(select 1 from pg_stat_activity
				where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'
				and query like '%api_keys%' and query like '%for update%') as blocked`;
			if (row?.blocked) {
				blocked = true;
				break;
			}
			await Bun.sleep(5);
		}
		expect(blocked).toBe(true);
	} finally {
		release.resolve();
		await Promise.allSettled([mutation, revocation]);
		context.events.emitChecked = original;
	}
	await mutation;
	await revocation;
	await expect(
		context.licenses.update(
			{ ids: [license.data.id], changes: { notes: "Denied after revocation" } },
			{ ...context.operation(), principal },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const state = await context.licenses.read(
		new URLSearchParams({ id: license.data.id }),
		context.operation(),
	);
	expect(state.data).toMatchObject({ notes: "Authorized before revocation" });
});

test("group grants filter reads and current grants replace admission snapshots", async () => {
	const issued = await key();
	const groupId = Bun.randomUUIDv7();
	const otherId = Bun.randomUUIDv7();
	await context.database.orm.insert(groups).values(
		[groupId, otherId].map((id) => ({
			id,
			name: id,
			createdBy: "root",
			updatedBy: "root",
		})),
	);
	await context.apiKeys.update(
		{
			ids: [issued.data.id],
			changes: { scopes: ["licenses:read"], groupIds: [groupId] },
		},
		context.operation(),
	);
	const principal = await context.auth.authenticate(
		`Bearer ${issued.credential}`,
	);
	const selected = await context.database.transaction(async (tx) => {
		const fresh = await context.auth.authorize(tx, principal, "licenses:read");
		context.auth.requireGroup(fresh, groupId);
		expect(() => context.auth.requireGroup(fresh, otherId)).toThrow();
		expect(() => context.auth.requireGroup(fresh, null)).toThrow();
		return tx
			.select({ id: groups.id })
			.from(groups)
			.where(context.auth.groupFilter(fresh, groups.id));
	});
	expect(selected).toEqual([{ id: groupId }]);
	await context.apiKeys.update(
		{ ids: [issued.data.id], changes: { scopes: [] } },
		context.operation(),
	);
	await expect(
		context.database.transaction((tx) =>
			context.auth.authorize(tx, principal, "licenses:read"),
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("rotation, disable and expiry invalidate already authenticated principals", async () => {
	for (const change of ["rotate", "disable", "expire"] as const) {
		const issued = await key();
		await context.apiKeys.update(
			{
				ids: [issued.data.id],
				changes: { scopes: ["licenses:read"], allGroups: true },
			},
			context.operation(),
		);
		const principal = await context.auth.authenticate(
			`Bearer ${issued.credential}`,
		);
		if (change === "rotate")
			await context.apiKeys.rotate(
				{ ids: [issued.data.id] },
				context.operation(),
			);
		else if (change === "disable")
			await context.apiKeys.disable(
				{ ids: [issued.data.id] },
				context.operation(),
			);
		else
			await context.database.orm
				.update(apiKeys)
				.set({ expiresAt: new Date(0) })
				.where(eq(apiKeys.id, issued.data.id));
		await expect(
			context.database.transaction((tx) =>
				context.auth.authorize(tx, principal, "licenses:read"),
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	}
});

test("idempotent API operations reauthorize before returning stored results", async () => {
	const issued = await key();
	await context.apiKeys.update(
		{
			ids: [issued.data.id],
			changes: { scopes: ["licenses:update"], allGroups: true },
		},
		context.operation(),
	);
	const principal = await context.auth.authenticate(
		`Bearer ${issued.credential}`,
	);
	const operation = { ...context.operation(), principal };
	let mutations = 0;
	const execute = () =>
		context.idempotency.admin(
			operation,
			"test.authority",
			{ id: issued.data.id },
			async () => {
				mutations++;
				return { data: { accepted: true } };
			},
			{
				authorize: (tx) =>
					context.auth.authorize(tx, principal, "licenses:update"),
			},
		);
	await execute();
	await expect(execute()).rejects.toMatchObject({
		result: { data: { accepted: true } },
	});
	await context.apiKeys.update(
		{ ids: [issued.data.id], changes: { scopes: [] } },
		context.operation(),
	);
	await expect(execute()).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(mutations).toBe(1);
});
