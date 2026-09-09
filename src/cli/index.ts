#!/usr/bin/env bun
import { Command } from "commander";
import { version } from "../../package.json";
import { createConnectedAdminService } from "../composition/services";
import type { AdminOperations } from "./AdminOperations";
import { registerCustomerCommands } from "./commands/customers";
import { registerLicenseCommands } from "./commands/licenses";

export interface AdminRuntime {
	service: AdminOperations;
	close(): void | Promise<void>;
}

export type AdminRuntimeFactory = () =>
	| AdminOperations
	| AdminRuntime
	| Promise<AdminOperations | AdminRuntime>;

async function createRuntimeAdminService(): Promise<AdminRuntime> {
	if (!Bun.env.KEYZORI_DATABASE_URL?.trim()) {
		throw new Error("KEYZORI_DATABASE_URL must be configured.");
	}
	if (!Bun.env.KEYZORI_REDIS_URL?.trim()) {
		throw new Error("KEYZORI_REDIS_URL must be configured.");
	}
	return await createConnectedAdminService();
}

function isConnectedRuntime(
	value: AdminOperations | AdminRuntime,
): value is AdminRuntime {
	return (
		"service" in value && "close" in value && typeof value.close === "function"
	);
}

export function createProgram(
	createRuntime: AdminRuntimeFactory = createRuntimeAdminService,
): Command {
	const program = new Command();
	program
		.name("keyzori admin")
		.description("Administer the local Keyzori server database")
		.version(version)
		.showHelpAfterError();

	let runtimePromise:
		| Promise<{ service: AdminOperations; close?: () => void | Promise<void> }>
		| undefined;
	let closed = false;
	const getRuntime = () => {
		runtimePromise ??= Promise.resolve(createRuntime()).then((runtime) =>
			isConnectedRuntime(runtime) ? runtime : { service: runtime },
		);
		return runtimePromise;
	};

	const lazyService = new Proxy({} as AdminOperations, {
		get:
			(_target, property) =>
			async (...args: unknown[]) => {
				const { service } = await getRuntime();
				const operation = service[property as keyof AdminOperations] as unknown;
				if (typeof operation !== "function") {
					throw new Error(
						`Admin operation ${String(property)} is unavailable.`,
					);
				}
				return await operation.apply(service, args);
			},
	});
	const getService = (): AdminOperations => {
		return lazyService;
	};

	program.hook("postAction", async () => {
		if (closed || !runtimePromise) return;
		closed = true;
		const runtime = await runtimePromise.catch(() => undefined);
		await runtime?.close?.();
	});

	registerCustomerCommands(program, getService);
	registerLicenseCommands(program, getService);
	return program;
}

async function main(): Promise<void> {
	await createProgram().parseAsync(process.argv);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
