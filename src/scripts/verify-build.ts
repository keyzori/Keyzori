import assert from "node:assert/strict";
import { resolve } from "node:path";
import { buildTargets, compileTarget } from "./build-targets";

const marker = `BUILD_SENTINEL_${Bun.randomUUIDv7()}`;
const targets =
	Bun.argv.length > 2 ? Bun.argv.slice(2) : Object.keys(buildTargets);
for (const target of targets) compileTarget(target);
const env = {
	...Bun.env,
	KZ_MASTER_KEY: marker,
	KZ_DATABASE_URL: `postgresql://${marker}@invalid.invalid/database`,
	KZ_REDIS_URL: `redis://${marker}@invalid.invalid:6379`,
};
const commands = [
	["src/scripts/openapi.ts"],
	...targets.map((target) => ["src/scripts/build.ts", target]),
];
for (const args of commands) {
	const child = Bun.spawn([process.execPath, ...args], {
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	assert.equal(await child.exited, 0, "Build must require no live credentials");
}
const checkout = resolve(".");
const forbidden = [
	marker,
	checkout,
	checkout.replaceAll("\\", "/"),
	JSON.stringify(checkout).slice(1, -1),
];
let count = 0;
for (const name of [
	"openapi.json",
	...targets.map(
		(target) =>
			`keyzori-${target}${target.startsWith("windows") ? ".exe" : ""}`,
	),
]) {
	const bytes = Buffer.from(
		await Bun.file(`dist/server/${name}`).arrayBuffer(),
	);
	for (const value of forbidden)
		assert.equal(
			bytes.includes(Buffer.from(value)),
			false,
			`${name} contains build environment data`,
		);
	count++;
}
console.log(`${count} artifacts exclude sentinel secrets and checkout paths`);
