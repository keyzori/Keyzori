import { aot } from "elysia/plugin/aot/bun";
import { resolve } from "node:path";
import { compileTarget } from "./build-targets";

const target = Bun.argv[2] ?? "linux-x64";
const compile = compileTarget(target);
const entry = resolve("src/main.ts");
const outputDirectory = resolve("dist/server");
process.chdir(resolve("src"));
const output = `${outputDirectory}/keyzori-${target}${target.startsWith("windows") ? ".exe" : ""}`;
const result = await Bun.build({
	entrypoints: [entry],
	target: "bun",
	minify: true,
	sourcemap: "none",
	plugins: [aot(entry, { target: "bun", strip: true })],
	compile: {
		target: compile,
		outfile: output,
		assets: ["./core/database/migrations"],
	},
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	throw new Error("Server build failed");
}
console.log(`Built ${output}`);
