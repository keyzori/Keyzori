import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { NoopLogger, type Logger } from "drizzle-orm/logger";
import { TestDatabase } from "../fixtures/TestDatabase";
import { AuthService } from "../../core/auth/AuthService";
import { migrationAssets } from "../../core/database/migrationAssets";
import { apiKeys } from "../../core/database/schema/apiKeys";
import { apiKeyGroups } from "../../core/database/schema/apiKeyGroups";
import { groups } from "../../core/database/schema/groups";
import { users } from "../../core/database/schema/users";
import { licenses } from "../../core/database/schema/licenses";
import { meters } from "../../core/database/schema/meters";
import { hardware } from "../../core/database/schema/hardware";
import { ips } from "../../core/database/schema/ips";
import { ClientIpResolver } from "../../core/http/ClientIpResolver";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import { IdempotencyService } from "../../core/security/IdempotencyService";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { AuditService } from "../../plugins/audits/AuditService";
import { LicenseDeletion } from "../../plugins/licenses/LicenseDeletion";
import { LicenseService } from "../../plugins/licenses/LicenseService";
import { LicenseView } from "../../plugins/licenses/LicenseView";
import { MeterService } from "../../plugins/licenses/MeterService";
import { SettingsService } from "../../plugins/settings/SettingsService";
import { EventService } from "../../plugins/webhooks/EventService";
import type { $Principal } from "../../types/auth";
import type { $Transaction } from "../../types/database";
import type { $ResourceSort } from "../../types/query";

// Bounded, local-only verification. Run just this file with the owned test-services
// runner. No API startup, credentials, production data or timing/plan-shape gates.
const fixture = new TestDatabase();
const database = fixture.database;
const auth = new AuthService(database, new KeyGenerator().master());
const audit = new AuditService();
const events = new EventService();
const ip = new ClientIpResolver(database);
const settings = new SettingsService(database, audit, ip);
const metering = new MeterService(audit, events);
const service = new LicenseService(
	database,
	auth,
	audit,
	events,
	settings,
	new IdempotencyService(database, settings, auth),
	metering,
	new LicenseDeletion(audit, events),
	ip,
);
const root: $Principal = { kind: "root", id: "root", name: "Root", scopes: [] };
const id = (n: number) =>
	`00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const groupId = (n: number) => id(10000 + n);
const userId = (n: number) => id(20000 + n);
const selected: $Principal = {
	kind: "api",
	id: id(30000),
	name: "Query-plan reader",
	scopes: ["licenses:read"],
	credentialHash: "fixture-only-query-plan-digest",
	allGroups: false,
	groupIds: [groupId(2), groupId(7)],
};
const createdBase = Date.UTC(2026, 0, 1);
const expiryBase = Date.UTC(2026, 6, 1);
const literalSearch = "%_\\needle' OR true --";
const licenseRows = Array.from({ length: 8000 }, (_, n) => {
	// Permute associations independently of creation order, with hot and small groups.
	const bucket = (n * 37) % 8000;
	return {
		id: id(n + 1),
		keyHash: new Bun.CryptoHasher("sha256")
			.update(`query-plan-fixture-${n}`)
			.digest("hex"),
		enabled: n % 7 !== 0,
		groupId:
			bucket < 4000
				? groupId(0)
				: bucket < 6000
					? groupId(1)
					: bucket < 7680
						? groupId(2 + Math.floor((bucket - 6000) / 120))
						: null,
		userId: n % 5 === 0 ? null : userId((n * 23) % 200),
		expiresAt:
			n % 4 === 0
				? null
				: new Date(expiryBase + Math.floor(((n * 13) % 8000) / 16) * 3600000),
		metadata: {
			cohort: n % 101 === 0 ? "priority'cohort" : "standard",
			seats: n % 97 === 0 ? 42 : n % 97 === 1 ? "42" : n % 11,
		},
		notes:
			n % 113 === 0
				? `Local ${literalSearch} marker ${n}`
				: `Fixture licence ${n}`,
		keyFormat: KeyGenerator.defaultFormat,
		createdBy: "query-plan-fixture",
		updatedBy: "query-plan-fixture",
		createdAt: new Date(createdBase + Math.floor(n / 8) * 60000),
		updatedAt: new Date(
			createdBase + 86400000 + Math.floor(((n * 17) % 8000) / 11) * 60000,
		),
	};
});
type SeedRow = (typeof licenseRows)[number];
type PlanNode = {
	"Node Type": string;
	"Actual Rows": number;
	"Actual Loops": number;
	"Relation Name"?: string;
	"Index Name"?: string;
	"Rows Removed by Filter"?: number;
	"Rows Removed by Index Recheck"?: number;
	Plans?: PlanNode[];
	[key: string]: unknown;
};
type Explanation = {
	Plan: PlanNode;
	"Planning Time": number;
	"Execution Time": number;
};

function order(
	rows: SeedRow[],
	sort: $ResourceSort,
	direction: "asc" | "desc",
) {
	return [...rows].sort((left, right) => {
		const a = left[sort];
		const b = right[sort];
		if (a === null && b !== null) return 1;
		if (a !== null && b === null) return -1;
		const comparison =
			(a && b ? a.getTime() - b.getTime() : 0) ||
			left.id.localeCompare(right.id);
		return direction === "asc" ? comparison : -comparison;
	});
}

// This is the collection selection from LicenseService.read. The service test
// below also compares its observed SQL and bindings to this measured builder.
function selection(
	query: ResourceQuery,
	principal = root,
	orm: Pick<typeof database.orm, "select"> = database.orm,
) {
	return orm
		.select()
		.from(licenses)
		.where(and(query.where, auth.groupFilter(principal, licenses.groupId)))
		.orderBy(...query.order)
		.limit(query.id ? 1 : query.limit + 1);
}

function scanNodes(node: PlanNode): Record<string, unknown>[] {
	return [
		...(node["Node Type"].includes("Scan")
			? [
					{
						type: node["Node Type"],
						relation: node["Relation Name"],
						index: node["Index Name"],
						rows: node["Actual Rows"],
						loops: node["Actual Loops"],
						removedByFilter: node["Rows Removed by Filter"] ?? 0,
						removedByRecheck: node["Rows Removed by Index Recheck"] ?? 0,
						// Per-node executor accounting; do not sum heap/index nodes or infer
						// unreported internal B-tree visits from this number.
						accountedRows:
							(node["Actual Rows"] +
								(node["Rows Removed by Filter"] ?? 0) +
								(node["Rows Removed by Index Recheck"] ?? 0)) *
							node["Actual Loops"],
					},
				]
			: []),
		...(node.Plans ?? []).flatMap(scanNodes),
	];
}

async function snapshot() {
	const tables = await database.orm.execute<{ tablename: string }>(sql`
		select tablename from pg_tables where schemaname = 'public' order by tablename`);
	const contents = [];
	for (const { tablename } of tables) {
		const [state] = await database.orm.execute(sql`
			select count(*)::integer as rows,
			md5(coalesce(string_agg(md5(to_jsonb(t)::text || ':' || t.xmin::text), '' order by to_jsonb(t)::text), '')) as digest
			from ${sql.identifier(tablename)} as t`);
		contents.push({ table: tablename, ...state });
	}
	const sequences = await database.orm.execute(sql`
		select sequencename, last_value::text from pg_sequences
		where schemaname = 'public' order by sequencename`);
	return { contents, sequences: [...sequences] };
}

let seeded: Awaited<ReturnType<typeof snapshot>> | undefined;
beforeAll(async () => {
	await fixture.start();
	await database.orm.insert(groups).values(
		Array.from({ length: 16 }, (_, n) => ({
			id: groupId(n),
			name: `Fixture group ${n}`,
			notes: "Group administrative notes",
			enabled: true,
			createdBy: "query-plan-fixture",
			updatedBy: "query-plan-fixture",
		})),
	);
	await database.orm.insert(users).values(
		Array.from({ length: 200 }, (_, n) => ({
			id: userId(n),
			name: `Fixture user ${n}`,
			notes: "User administrative notes",
			enabled: true,
			createdBy: "query-plan-fixture",
			updatedBy: "query-plan-fixture",
		})),
	);
	// Fixed batch/row ceiling: never turn this regression into a stress benchmark.
	for (let offset = 0; offset < licenseRows.length; offset += 250)
		await database.orm
			.insert(licenses)
			.values(licenseRows.slice(offset, offset + 250));
	await database.orm.insert(apiKeys).values({
		id: selected.id,
		name: selected.name,
		secretHash: selected.credentialHash,
		scopes: ["licenses:read"],
		enabled: true,
		createdBy: "query-plan-fixture",
		updatedBy: "query-plan-fixture",
	});
	await database.orm
		.insert(apiKeyGroups)
		.values(
			selected.groupIds.map((groupId) => ({ apiKeyId: selected.id, groupId })),
		);
	for (const [licenseId, counterCount] of [
		[id(2), 2],
		[id(3), 8],
	] as const) {
		await database.orm.insert(meters).values(
			Array.from({ length: counterCount }, (_, n) => ({
				id: Bun.randomUUIDv7(),
				licenseId,
				name: `counter-${n}`,
				value: "7",
				limit: "100",
				schedule: {
					interval: "day" as const,
					time: "00:00",
					timezone: "UTC",
				},
				periodStartedAt: new Date("2020-01-01T00:00:00.000Z"),
				nextResetAt: new Date("2020-01-02T00:00:00.000Z"),
			})),
		);
		await database.orm.insert(hardware).values({
			id: Bun.randomUUIDv7(),
			licenseId,
			hardwareId: "fixture-device",
		});
		await database.orm
			.insert(ips)
			.values({ id: Bun.randomUUIDv7(), licenseId, ip: "127.0.0.1" });
	}
	await database.orm.execute(sql`analyze`);
	seeded = await snapshot();
	const [version] = await database.orm.execute(
		sql`select current_setting('server_version') as postgres`,
	);
	console.log(
		"query-plan-dataset",
		JSON.stringify({
			fixtureRun: Bun.env.KZ_TEST_RUN_ID,
			indexProbes: Bun.env.KZ_QUERY_PLAN_INDEX_PROBES === "1",
			bun: Bun.revision,
			...version,
			migrations: migrationAssets.map(({ name, hash }) => ({ name, hash })),
			licences: licenseRows.length,
			groups: 16,
			users: 200,
			groupRows: [4000, 2000, ...Array.from({ length: 14 }, () => 120)],
			ungrouped: licenseRows.filter((row) => row.groupId === null).length,
			unassociated: licenseRows.filter((row) => row.userId === null).length,
			nullExpiry: licenseRows.filter((row) => row.expiresAt === null).length,
			createdTimestampTies: 8,
			overdueCounters: 10,
			measurement:
				"Three sequential EXPLAIN ANALYZE BUFFERS samples after seed/ANALYZE; cache-warm local fixture, no latency SLO or throughput inference. Full first plan retained; per-node scan accounting is not a global rows-scanned total.",
		}),
	);
}, 60000);

afterAll(async () => {
	try {
		if (seeded) expect(await snapshot()).toEqual(seeded);
	} finally {
		await fixture.stop();
	}
}, 30000);

async function measure(
	tx: $Transaction,
	name: string,
	params: Record<string, string>,
	matching: SeedRow[],
	principal = root,
	after = 0,
) {
	const input = new URLSearchParams({ limit: "50", ...params });
	let query = new ResourceQuery(input, licenses);
	const expected = order(
		matching,
		query.sort,
		input.get("direction") === "asc" ? "asc" : "desc",
	);
	if (after) {
		const previous = expected[after - 1];
		if (!previous) throw new Error("Invalid fixture cursor offset");
		input.set("cursor", query.cursor(previous));
		query = new ResourceQuery(input, licenses);
	}
	const statement = selection(query, principal, tx);
	const rows = await statement;
	expect(rows.map((row) => row.id)).toEqual(
		expected.slice(after, after + 51).map((row) => row.id),
	);
	const samples: Explanation[] = [];
	for (let sample = 0; sample < 3; sample++) {
		const [result] = await tx.execute<{ "QUERY PLAN": Explanation[] }>(sql`
			explain (analyze, buffers, format json) ${statement.getSQL()}`);
		const explanation = result?.["QUERY PLAN"][0];
		if (!explanation)
			throw new Error("PostgreSQL did not return an execution plan");
		samples.push(explanation);
	}
	const first = samples[0];
	if (!first) throw new Error("Missing measured plan");
	console.log(
		"query-plan",
		JSON.stringify({
			name,
			matched: matching.length,
			after,
			fetched: rows.length,
			sql: statement.toSQL(),
			executionMs: samples.map((sample) => sample["Execution Time"]),
			planningMs: samples.map((sample) => sample["Planning Time"]),
			scans: scanNodes(first.Plan),
			explanation: first,
		}),
	);
}

test("supported collection SQL returns exact rows and exposes bounded execution plans", async () => {
	await database.orm.transaction(async (tx) => {
		await tx.execute(sql`set transaction read only`);
		for (const sort of ["createdAt", "updatedAt", "expiresAt"] as const) {
			for (const direction of ["asc", "desc"] as const) {
				await measure(
					tx,
					`${sort}-${direction}-head`,
					{ sort, direction },
					licenseRows,
				);
				await measure(
					tx,
					`${sort}-${direction}-deep`,
					{ sort, direction },
					licenseRows,
					root,
					sort === "expiresAt" ? 5900 : 6000,
				);
			}
		}
		for (const n of [0, 2]) {
			const matching = licenseRows.filter((row) => row.groupId === groupId(n));
			await measure(
				tx,
				`group-${n === 0 ? "hot" : "small"}`,
				{ groupId: groupId(n) },
				matching,
			);
			await measure(
				tx,
				`group-${n === 0 ? "hot" : "small"}-deep`,
				{ groupId: groupId(n) },
				matching,
				root,
				n === 0 ? 3000 : 60,
			);
		}
		const visible = licenseRows.filter(
			(row) => row.groupId !== null && selected.groupIds.includes(row.groupId),
		);
		await measure(tx, "selected-group-authority", {}, visible, selected);
		await measure(
			tx,
			"selected-group-authority-deep",
			{},
			visible,
			selected,
			150,
		);
		await measure(
			tx,
			"user-association",
			{ userId: userId(23) },
			licenseRows.filter((row) => row.userId === userId(23)),
		);
		const before = new Date(expiryBase + 48 * 3600000);
		const after = new Date(expiryBase + 44 * 3600000);
		await measure(
			tx,
			"expiry-range",
			{
				sort: "expiresAt",
				direction: "asc",
				expiresAfter: after.toISOString(),
				expiresBefore: before.toISOString(),
			},
			licenseRows.filter(
				(row) =>
					row.expiresAt !== null &&
					row.expiresAt > after &&
					row.expiresAt < before,
			),
		);
		await measure(
			tx,
			"expiry-null",
			{ sort: "expiresAt", hasExpiry: "false" },
			licenseRows.filter((row) => row.expiresAt === null),
		);
		await measure(
			tx,
			"metadata-string",
			{ "metadata.cohort": "priority'cohort" },
			licenseRows.filter((row) => row.metadata.cohort === "priority'cohort"),
		);
		await measure(
			tx,
			"metadata-number",
			{ "metadataNumber.seats": "42" },
			licenseRows.filter((row) => row.metadata.seats === 42),
		);
		await measure(
			tx,
			"substring",
			{ search: "needle" },
			licenseRows.filter((row) => row.notes.toLowerCase().includes("needle")),
		);
	});
}, 60000);

test("timestamp/UUID cursors visit each row once across ties and nullable expiry in both directions", async () => {
	const before = new Date(createdBase + 32 * 60000);
	const matching = licenseRows.filter((row) => row.createdAt < before);
	for (const sort of ["createdAt", "updatedAt", "expiresAt"] as const) {
		for (const direction of ["asc", "desc"] as const) {
			const params = new URLSearchParams({
				limit: "37",
				sort,
				direction,
				createdBefore: before.toISOString(),
			});
			const seen: string[] = [];
			for (let page = 0; page <= Math.ceil(matching.length / 37); page++) {
				const query = new ResourceQuery(params, licenses);
				const rows = await selection(query);
				seen.push(...rows.slice(0, query.limit).map((row) => row.id));
				if (rows.length <= query.limit) break;
				const last = rows[query.limit - 1];
				if (!last) throw new Error("Page did not contain its boundary");
				params.set("cursor", query.cursor(last));
			}
			expect(seen).toEqual(
				order(matching, sort, direction).map((row) => row.id),
			);
			expect(new Set(seen).size).toBe(matching.length);
		}
	}
});

test("non-null time sorts reject null cursors and UUID searches retain typed equality", async () => {
	const row = licenseRows[170];
	if (!row) throw new Error("Missing UUID search fixture");
	for (const sort of ["createdAt", "updatedAt"] as const) {
		const params = new URLSearchParams({ sort });
		const query = new ResourceQuery(params, licenses);
		const decoded = JSON.parse(
			Buffer.from(query.cursor(row), "base64url").toString(),
		);
		params.set(
			"cursor",
			Buffer.from(JSON.stringify({ ...decoded, value: null })).toString(
				"base64url",
			),
		);
		expect(() => new ResourceQuery(params, licenses)).toThrow();
	}
	const search = row.id.toUpperCase();
	const query = new ResourceQuery(new URLSearchParams({ search }), licenses);
	const statement = selection(query);
	expect((await statement).map((entry) => entry.id)).toEqual([row.id]);
	expect(statement.toSQL().params).toContain(search);
	expect(statement.toSQL().sql).not.toContain("::text");
	// Resources without text-search columns must not turn a non-UUID search into
	// an absent predicate and return the entire collection.
	const identifiers = new ResourceQuery(
		new URLSearchParams({ search: "not-a-uuid" }),
		{
			id: licenses.id,
			createdAt: licenses.createdAt,
			updatedAt: licenses.updatedAt,
		},
	);
	expect(await selection(identifiers)).toHaveLength(0);
});

test("metadata scalars and substring wildcards remain bound data with exact matching semantics", async () => {
	for (const [params, matching, bindings] of [
		[
			{ search: literalSearch },
			licenseRows.filter((row) => row.notes.includes(literalSearch)),
			["%\\%\\_\\\\needle' OR true --%"],
		],
		[
			{ "metadata.cohort": "priority'cohort" },
			licenseRows.filter((row) => row.metadata.cohort === "priority'cohort"),
			["cohort", "priority'cohort"],
		],
		[
			{ "metadataNumber.seats": "42" },
			licenseRows.filter((row) => row.metadata.seats === 42),
			["seats", "42"],
		],
		[
			{ "metadata.seats": "42" },
			licenseRows.filter((row) => row.metadata.seats === "42"),
			["seats", "42"],
		],
		[
			{ "metadata.x') OR true --": "unmatched'" },
			[],
			["x') OR true --", "unmatched'"],
		],
	] as const) {
		const query = new ResourceQuery(
			new URLSearchParams({ ...params, limit: "100" }),
			licenses,
		);
		const statement = selection(query);
		const compiled = statement.toSQL();
		for (const binding of bindings) {
			expect(compiled.sql).not.toContain(binding);
			expect(compiled.params).toContain(binding);
		}
		expect((await statement).map((row) => row.id)).toEqual(
			order([...matching], "createdAt", "desc").map((row) => row.id),
		);
	}
});

async function observed<T>(work: () => Promise<T>) {
	const statements: { sql: string; params: unknown[] }[] = [];
	// Observe Drizzle's exported default logger rather than substituting the DB
	// or transaction implementation. Native Bun BEGIN/COMMIT are not logged here.
	const defaultLogger: Logger = NoopLogger.prototype;
	const logger = spyOn(defaultLogger, "logQuery").mockImplementation(
		(text, params) => {
			statements.push({ sql: text, params });
		},
	);
	try {
		const started = performance.now();
		const result = await work();
		return { result, statements, elapsedMs: performance.now() - started };
	} finally {
		logger.mockRestore();
	}
}

function observedRead(params: Record<string, string>, principal = root) {
	return observed(() =>
		service.read(new URLSearchParams(params), {
			principal,
			clientIp: "127.0.0.1",
			requestId: Bun.randomUUIDv7(),
		}),
	);
}

test("collection reads have page-size-independent query counts; overdue detail reads do not persist resets", async () => {
	const before = await snapshot();
	const observations = [];
	for (const principal of [root, selected]) {
		const counts = [];
		for (const limit of [1, 50, 100]) {
			const observation = await observedRead(
				{ limit: String(limit) },
				principal,
			);
			expect(Array.isArray(observation.result.data)).toBe(true);
			if (!Array.isArray(observation.result.data))
				throw new Error("Expected collection");
			expect(observation.result.data).toHaveLength(limit);
			const expected = selection(
				new ResourceQuery(
					new URLSearchParams({ limit: String(limit) }),
					licenses,
				),
				principal,
			).toSQL();
			expect(
				observation.statements.filter((entry) =>
					entry.sql.includes('from "licenses"'),
				),
			).toEqual([{ sql: expected.sql, params: expected.params }]);
			for (const row of observation.result.data) {
				expect(row).not.toHaveProperty("meters");
				if (principal.kind === "api")
					expect(
						row.groupId !== null && principal.groupIds.includes(row.groupId),
					).toBe(true);
			}
			counts.push(observation.statements.length);
			observations.push({
				kind: "collection",
				authority: principal.kind,
				limit,
				queryCount: observation.statements.length,
				elapsedMs: observation.elapsedMs,
				statements: observation.statements.map((entry) => entry.sql),
			});
		}
		// Detect N+1 regressions without freezing implementation-specific fixed overhead.
		expect(new Set(counts).size).toBe(1);
	}
	const scheduledCounts = [];
	for (const [licenseId, counters] of [
		[id(4), 0],
		[id(2), 2],
		[id(3), 8],
		[id(3), 8],
	] as const) {
		const observation = await observedRead({ id: licenseId });
		if (Array.isArray(observation.result.data))
			throw new Error("Expected detail");
		expect(observation.result.data.meters).toHaveLength(counters);
		for (const counter of observation.result.data.meters)
			expect(counter.value).toBe("0");
		if (counters) {
			scheduledCounts.push(observation.statements.length);
			expect(observation.result.data.hardwareIds).toEqual(["fixture-device"]);
			expect(observation.result.data.registeredIps).toEqual(["127.0.0.1"]);
			expect(observation.result.data.group?.notes).toBe(
				"Group administrative notes",
			);
			expect(observation.result.data.user?.notes).toBe(
				"User administrative notes",
			);
		}
		observations.push({
			kind: "detail",
			overdueCounters: counters,
			queryCount: observation.statements.length,
			elapsedMs: observation.elapsedMs,
			statements: observation.statements.map((entry) => entry.sql),
		});
	}
	// Repeated schedules share work within each read, but a later read still
	// validates/recomputes instead of consulting a global validity cache.
	expect(new Set(scheduledCounts).size).toBe(1);
	expect(await snapshot()).toEqual(before);
	console.log(
		"query-counts",
		JSON.stringify({
			scope:
				"Actual LicenseService.read including current authorization, settings, transaction configuration and topology locks; excludes native BEGIN/COMMIT and HTTP authentication/last-used bookkeeping.",
			persistentDomainEffects:
				"All public-table contents, xmin row versions and sequence positions unchanged, including overdue counters, audits, usage and events.",
			observations,
		}),
	);
}, 30000);

test("projection reuse separates schedules and request instants and preserves validation notes exclusion", async () => {
	const [row] = await database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, id(3)))
		.limit(1);
	const [license] = await database.orm
		.select()
		.from(licenses)
		.where(eq(licenses.id, id(3)));
	if (!row?.schedule || !license) throw new Error("Missing projection fixture");
	const schedule = row.schedule;
	await database.orm.transaction(async (tx) => {
		const [clock] = await tx
			.select({ now: sql<Date>`'2026-03-01T08:00:00Z'::timestamptz` })
			.from(sql`(values (1)) as clock`);
		if (!clock) throw new Error("Missing fixture database clock");
		const sameSchedule = {
			...row,
			id: id(40001),
			name: "same-schedule",
			definitionRevision: 2,
			schedule: { timezone: "UTC", time: "00:00", interval: "day" as const },
		};
		const otherSchedule = {
			...row,
			id: id(40002),
			name: "other-schedule",
			schedule: { ...schedule, time: "12:00" },
		};
		const currentPeriod = {
			...row,
			id: id(40003),
			name: "current-period",
			periodStartedAt: new Date("2026-03-01T00:00:00Z"),
			nextResetAt: new Date("2026-03-02T00:00:00Z"),
		};
		const projected = await metering.projectMany(
			tx,
			[row, sameSchedule, otherSchedule, currentPeriod],
			clock.now,
		);
		expect(projected[0]).toMatchObject({
			value: "0",
			periodStartedAt: "2026-03-01T00:00:00.000Z",
			periodEndsAt: "2026-03-02T00:00:00.000Z",
		});
		expect(projected[1]).toMatchObject({
			counterId: sameSchedule.id,
			definitionRevision: 2,
			value: "0",
			periodStartedAt: "2026-03-01T00:00:00.000Z",
		});
		expect(projected[2]).toMatchObject({
			value: "0",
			periodStartedAt: "2026-02-28T12:00:00.000Z",
			periodEndsAt: "2026-03-01T12:00:00.000Z",
		});
		expect(projected[3]?.value).toBe("7");
		const later = await metering.projectMany(
			tx,
			[row],
			new Date(clock.now.getTime() + 86400000),
		);
		expect(later[0]).toMatchObject({
			value: "0",
			periodStartedAt: "2026-03-02T00:00:00.000Z",
			periodEndsAt: "2026-03-03T00:00:00.000Z",
		});
		const validation = await new LicenseView(metering).validation(
			tx,
			license,
			clock.now,
		);
		expect(validation).not.toHaveProperty("notes");
		expect(validation.group).not.toHaveProperty("notes");
		expect(validation.user).not.toHaveProperty("notes");
		const invalid = {
			...row,
			schedule: { ...schedule, unexpected: "must still be validated" },
		};
		await expect(
			metering.projectMany(tx, [row, invalid], clock.now),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});
});

// Explicit opt-in experiments only affect this owned database and roll back all
// candidate DDL. Compare these named plans to the ordinary plans above before
// adding an index to the application schema; no optimizer choice is asserted.
test.skipIf(Bun.env.KZ_QUERY_PLAN_INDEX_PROBES !== "1")(
	"compare ordered index candidates in a rolled-back fixture transaction",
	async () => {
		await expect(
			database.orm.transaction(async (tx) => {
				await tx.execute(sql`drop index if exists licenses_group_idx`);
				await tx.execute(sql`drop index if exists licenses_group_created_idx`);
				await tx.execute(
					sql`create index query_probe_group_created_idx on licenses (group_id, created_at, id)`,
				);
				for (const n of [0, 2]) {
					const matching = licenseRows.filter(
						(row) => row.groupId === groupId(n),
					);
					await measure(
						tx,
						`candidate-group-${n === 0 ? "hot" : "small"}`,
						{ groupId: groupId(n) },
						matching,
					);
					await measure(
						tx,
						`candidate-group-${n === 0 ? "hot" : "small"}-deep`,
						{ groupId: groupId(n) },
						matching,
						root,
						n === 0 ? 3000 : 60,
					);
				}
				const visible = licenseRows.filter(
					(row) =>
						row.groupId !== null && selected.groupIds.includes(row.groupId),
				);
				await measure(
					tx,
					"candidate-selected-group-authority",
					{},
					visible,
					selected,
				);
				await tx.execute(
					sql`create index query_probe_expiry_page_idx on licenses (expires_at desc nulls last, id desc)`,
				);
				for (const direction of ["asc", "desc"] as const) {
					await measure(
						tx,
						`candidate-expiry-${direction}-head`,
						{ sort: "expiresAt", direction },
						licenseRows,
					);
					await measure(
						tx,
						`candidate-expiry-${direction}-deep`,
						{ sort: "expiresAt", direction },
						licenseRows,
						root,
						5900,
					);
				}
				await measure(
					tx,
					"candidate-expiry-null",
					{ sort: "expiresAt", hasExpiry: "false" },
					licenseRows.filter((row) => row.expiresAt === null),
				);
				tx.rollback();
			}),
		).rejects.toBeInstanceOf(TransactionRollbackError);
	},
	60000,
);
