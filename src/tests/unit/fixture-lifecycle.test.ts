import { expect, test } from "bun:test";
import { TestServices } from "../../scripts/test-services";
import type { command, CommandOptions } from "../../scripts/command";

function fixtureDocker(
	intercept?: (args: string[], options: CommandOptions) => Promise<void>,
) {
	const containers = new Map<string, { id: string; owner: string }>();
	const removed: string[] = [];
	const calls: string[][] = [];
	const execute: typeof command = async (args, options = {}) => {
		calls.push(args);
		options.signal?.throwIfAborted();
		if (args[1] === "run") {
			const name = args[args.indexOf("--name") + 1];
			const label = args[args.indexOf("--label") + 1];
			if (!name || !label) throw new Error("Missing fixture ownership");
			containers.set(name, {
				id: String(containers.size + 1).padStart(64, "0"),
				owner: label.split("=")[1] ?? "",
			});
		}
		await intercept?.(args, options);
		let output = "";
		if (args[1] === "port") output = "127.0.0.1:54321";
		if (args[1] === "ps") {
			const filter = args[args.indexOf("--filter") + 1];
			const name = args[args.indexOf("--filter") + 1]
				?.replace(/^name=\^\//, "")
				.replace(/\$$/, "");
			if (name && containers.has(name)) output = name;
			if (filter?.startsWith("label=dev.keyzori.test-run="))
				output = [...containers]
					.filter(([, entry]) => entry.owner === filter.split("=").at(-1))
					.map(([name]) => name)
					.join("\n");
		}
		if (args[1] === "inspect") {
			const entry = containers.get(args.at(-1) ?? "");
			if (entry) output = `${entry.id} ${entry.owner}`;
		}
		if (args[1] === "rm") removed.push(args.at(-1) ?? "");
		return { code: 0, output, diagnostic: "" };
	};
	return { execute, containers, removed, calls };
}

test("interrupted startup cancels an in-flight command, never starts Redis, and removes its owned partial container", async () => {
	const entered = Promise.withResolvers<void>();
	const docker = fixtureDocker(async (args, options) => {
		if (args[1] !== "run") return;
		entered.resolve();
		await new Promise<void>((_resolve, reject) => {
			options.signal?.addEventListener(
				"abort",
				() => reject(options.signal?.reason),
				{ once: true },
			);
		});
	});
	const services = new TestServices({ execute: docker.execute });
	const cancellation = new AbortController();
	const startup = services.start(cancellation.signal);
	await entered.promise;
	cancellation.abort(new Error("Startup interrupted"));
	await expect(startup).rejects.toThrow("Startup interrupted");
	await services.stop();
	expect(docker.calls.filter((args) => args[1] === "run")).toHaveLength(1);
	expect(docker.removed).toEqual(["1".padStart(64, "0")]);
});

test("concurrent fixture runs use separate labels, names and passwords", async () => {
	const first = fixtureDocker();
	const second = fixtureDocker();
	const runs = [
		new TestServices({ execute: first.execute }),
		new TestServices({ execute: second.execute }),
	];
	try {
		const [a, b] = await Promise.all(runs.map((run) => run.start()));
		expect(a?.databaseUrl).not.toBe(b?.databaseUrl);
		expect(
			[...first.containers.keys()].some((name) => second.containers.has(name)),
		).toBe(false);
	} finally {
		await Promise.all(runs.map((run) => run.stop()));
	}
	expect(first.removed).toHaveLength(2);
	expect(second.removed).toHaveLength(2);
});

test("cleanup preserves foreign ownership and still removes the other owned container", async () => {
	const docker = fixtureDocker();
	const services = new TestServices({ execute: docker.execute });
	await services.start();
	const pg = [...docker.containers.values()][0];
	if (!pg) throw new Error("Missing PostgreSQL fixture");
	pg.owner = "different-run";
	await expect(services.stop()).rejects.toThrow("Fixture cleanup failed");
	expect(docker.removed).toEqual(["2".padStart(64, "0")]);
});

test("the parent runner recovers labelled runtime resources left by an interrupted child", async () => {
	const docker = fixtureDocker();
	const services = new TestServices({ execute: docker.execute });
	await services.start();
	const owner = [...docker.containers.values()][0]?.owner;
	if (!owner) throw new Error("Missing parent ownership");
	const id = "3".padStart(64, "0");
	docker.containers.set(`keyzori-tls-${Bun.randomUUIDv7()}`, { id, owner });
	docker.containers.set(`keyzori-tls-${Bun.randomUUIDv7()}`, {
		id: "4".padStart(64, "0"),
		owner: "different-run",
	});
	await services.stop();
	expect(docker.removed.sort()).toEqual([
		"1".padStart(64, "0"),
		"2".padStart(64, "0"),
		id,
	]);
});

test("cleanup attempts both containers and bounds a stalled Docker cleanup", async () => {
	const inspected: string[] = [];
	const docker = fixtureDocker(async (args, options) => {
		if (args[1] !== "inspect") return;
		inspected.push(args.at(-1) ?? "");
		if (args.at(-1)?.includes("-pg-")) throw new Error("Inspect failed");
		await new Promise<void>((_resolve, reject) => {
			options.signal?.addEventListener(
				"abort",
				() => reject(options.signal?.reason),
				{ once: true },
			);
		});
	});
	const services = new TestServices({
		execute: docker.execute,
		cleanupTimeoutMs: 30,
	});
	await services.start();
	const start = Date.now();
	try {
		await services.stop();
		throw new Error("Expected cleanup failure");
	} catch (error) {
		expect(error).toBeInstanceOf(AggregateError);
		if (error instanceof AggregateError) expect(error.errors).toHaveLength(2);
	}
	expect(inspected).toHaveLength(2);
	expect(Date.now() - start).toBeLessThan(2000);
});
