import { cp, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const appDirectory = resolve(import.meta.dir, "..");
const outputDirectory = resolve(appDirectory, "dist");
const outputFile = resolve(outputDirectory, "keyzori");

await rm(outputDirectory, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: [resolve(appDirectory, "src/main.ts")],
	compile: { outfile: outputFile },
	minify: true,
	bytecode: true,
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

await cp(
	resolve(appDirectory, "drizzle"),
	resolve(outputDirectory, "drizzle"),
	{
		recursive: true,
	},
);

for (const legalFile of ["LICENSE"] as const) {
	await cp(
		resolve(appDirectory, "../..", legalFile),
		resolve(outputDirectory, legalFile),
	);
}

const executable =
	process.platform === "win32" ? `${outputFile}.exe` : outputFile;
const executableStats = await stat(executable);
console.log(
	`Compiled ${executable} (${(executableStats.size / 1024 / 1024).toFixed(1)} MiB)`,
);
