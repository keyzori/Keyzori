import { $ } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { createProgram } from "../cli";
import type { AdminOperations } from "../cli/AdminOperations";

const cliEntrypoint = `${import.meta.dir}/../cli/index.ts`;

interface Invocation {
	method: string;
	args: unknown[];
}

function serviceProxy(
	invocations: Invocation[],
	result?: (method: string, args: unknown[]) => unknown,
): AdminOperations {
	return new Proxy(
		{},
		{
			get: (_target, property) => {
				if (property === "then") return undefined;
				return async (...args: unknown[]) => {
					const method = String(property);
					invocations.push({ method, args });
					return result?.(method, args) ?? { ok: true };
				};
			},
		},
	) as AdminOperations;
}

async function runInjected(
	args: string[],
	service: AdminOperations,
): Promise<string> {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...values: unknown[]) => {
		lines.push(values.map(String).join(" "));
	};
	try {
		await createProgram(() => service).parseAsync(["bun", "test", ...args]);
	} finally {
		console.log = original;
	}
	return lines.join("\n");
}

afterEach(() => {
	process.exitCode = 0;
});

describe("server administration CLI", () => {
	it("shows canonical help without opening database or Redis connections", async () => {
		const { stdout } = await $`bun ${cliEntrypoint} --help`
			.env({
				...process.env,
				KEYZORI_DATABASE_URL: "",
				KEYZORI_REDIS_URL: "",
			})
			.quiet();
		const output = stdout.toString();
		expect(output).toContain("Usage: keyzori admin");
		expect(output).toContain("customers");
		expect(output).toContain("licenses");
		expect(output).not.toContain("create-key");
		expect(output).not.toContain("list-keys");
		expect(output).not.toContain("create-user");
	});

	it("requires runtime configuration only after a command is selected", async () => {
		const result = await $`bun ${cliEntrypoint} customers list`
			.env({ ...process.env, KEYZORI_DATABASE_URL: "" })
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(
			"KEYZORI_DATABASE_URL must be configured",
		);
	});

	it("closes the connected Redis-backed runtime after a command", async () => {
		const invocations: Invocation[] = [];
		let created = 0;
		let closed = 0;
		const service = serviceProxy(invocations, () => []);
		const program = createProgram(async () => {
			created += 1;
			return {
				service,
				close: () => {
					closed += 1;
				},
			};
		});

		const original = console.log;
		console.log = () => {};
		try {
			await program.parseAsync(["bun", "test", "customers", "list"]);
		} finally {
			console.log = original;
		}

		expect(created).toBe(1);
		expect(closed).toBe(1);
		expect(invocations).toEqual([{ method: "listCustomers", args: [] }]);
	});

	it("dispatches every canonical license type with canonical fields", async () => {
		const invocations: Invocation[] = [];
		const service = serviceProxy(invocations, (_method, args) => ({
			...(args[0] as object),
			id: "license-1",
			keyPrefix: "lic_test",
			licenseKey: "lic_SECRET",
		}));

		await runInjected(
			[
				"licenses",
				"create",
				"--customer-id",
				"customer-1",
				"--type",
				"lifetime",
				"--max-ips",
				"2",
				"--max-devices",
				"3",
				"--max-sessions",
				"4",
				"--metadata",
				'{"plan":"pro"}',
			],
			service,
		);
		await runInjected(
			[
				"licenses",
				"create",
				"--customer-id",
				"customer-1",
				"--type",
				"subscription",
				"--expires-at",
				"2099-01-01T00:00:00Z",
			],
			service,
		);
		await runInjected(
			[
				"licenses",
				"create",
				"--customer-id",
				"customer-1",
				"--type",
				"metered",
				"--meter",
				"requests=100",
				"--meter-reason",
				"Initial allocation",
			],
			service,
		);
		await runInjected(
			[
				"licenses",
				"create",
				"--customer-id",
				"customer-1",
				"--type",
				"trial",
				"--trial-duration-minutes",
				"60",
			],
			service,
		);

		const inputs = invocations.map((invocation) => invocation.args[0]) as Array<
			Record<string, unknown>
		>;
		expect(inputs.map((input) => input.type)).toEqual([
			"lifetime",
			"subscription",
			"metered",
			"trial",
		]);
		expect(inputs[0]).toMatchObject({
			customerId: "customer-1",
			maxIps: 2,
			maxDevices: 3,
			maxSessions: 4,
			metadata: { plan: "pro" },
		});
		expect(inputs[2]?.meters).toEqual([
			{
				name: "requests",
				balance: 100,
				reason: "Initial allocation",
			},
		]);
		expect(inputs[3]?.trialDurationMinutes).toBe(60);
	});

	it("reveals license keys only from create and rotate", async () => {
		const invocations: Invocation[] = [];
		const secretResult = {
			id: "license-1",
			keyPrefix: "lic_SECR",
			licenseKey: "lic_SECRET_VALUE",
		};
		const service = serviceProxy(invocations, (method) => {
			if (method === "listLicenses") return [secretResult];
			return secretResult;
		});

		const created = await runInjected(
			["licenses", "create", "--customer-id", "customer-1"],
			service,
		);
		const rotated = await runInjected(
			["licenses", "rotate", "license-1"],
			service,
		);
		const listed = await runInjected(["licenses", "list"], service);
		const fetched = await runInjected(
			["licenses", "get", "license-1"],
			service,
		);

		expect(created).toContain("lic_SECRET_VALUE");
		expect(rotated).toContain("lic_SECRET_VALUE");
		expect(listed).not.toContain("lic_SECRET_VALUE");
		expect(fetched).not.toContain("lic_SECRET_VALUE");
		expect(listed).toContain("lic_SECR");
	});

	it("dispatches customer, license, access, and meter management", async () => {
		const invocations: Invocation[] = [];
		const service = serviceProxy(invocations, (method) =>
			method === "terminateLicenseSessions" ? 2 : { ok: true },
		);
		await runInjected(
			[
				"customers",
				"update",
				"customer-1",
				"--name",
				"Acme",
				"--metadata",
				'{"tier":2}',
			],
			service,
		);
		await runInjected(
			["licenses", "revoke", "license-1", "--reason", "chargeback"],
			service,
		);
		await runInjected(
			["licenses", "access", "terminate-sessions", "license-1"],
			service,
		);
		await runInjected(
			[
				"licenses",
				"meters",
				"create",
				"license-1",
				"--name",
				"exports",
				"--balance",
				"100",
				"--reason",
				"initial allocation",
			],
			service,
		);
		await runInjected(
			[
				"licenses",
				"meters",
				"adjust",
				"license-1",
				"--name",
				"requests",
				"--delta",
				"-5",
				"--reason",
				"correction",
			],
			service,
		);
		await runInjected(
			[
				"licenses",
				"meters",
				"archive",
				"license-1",
				"--name",
				"exports",
				"--reason",
				"retired",
			],
			service,
		);

		expect(invocations).toEqual([
			{
				method: "updateCustomer",
				args: ["customer-1", { name: "Acme", metadata: { tier: 2 } }],
			},
			{
				method: "revokeLicense",
				args: ["license-1", "chargeback"],
			},
			{ method: "terminateLicenseSessions", args: ["license-1"] },
			{
				method: "createLicenseMeter",
				args: [
					"license-1",
					{ name: "exports", balance: 100, reason: "initial allocation" },
				],
			},
			{
				method: "adjustLicenseMeter",
				args: ["license-1", "requests", -5, "correction"],
			},
			{
				method: "archiveLicenseMeter",
				args: ["license-1", "exports", "retired"],
			},
		]);
	});

	it("rejects invalid numbers, JSON, dates, reasons, and legacy commands", async () => {
		const cases = [
			["licenses", "create", "--customer-id", "c1", "--max-ips", "1abc"],
			[
				"customers",
				"create",
				"--email",
				"a@b.test",
				"--name",
				"A",
				"--metadata",
				"[]",
			],
			["licenses", "renew", "l1", "--expires-at", "not-a-date"],
			["licenses", "revoke", "l1", "--reason", "   "],
			[
				"licenses",
				"meters",
				"create",
				"l1",
				"--name",
				"exports",
				"--balance",
				"100",
			],
			["licenses", "meters", "archive", "l1", "--name", "exports"],
			["create-key"],
		] as const;

		for (const args of cases) {
			const result = await $`bun ${cliEntrypoint} ${args}`
				.env({
					...process.env,
					KEYZORI_DATABASE_URL: "",
					KEYZORI_REDIS_URL: "",
				})
				.quiet()
				.nothrow();
			expect(result.exitCode).not.toBe(0);
		}
	});
});
