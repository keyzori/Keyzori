import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

test.each([
	["README.md", "Docker"],
	["src/README.md", "Run"],
])(
	"%s Compose instructions name every required environment input",
	async (source, heading) => {
		const compose = await Bun.file(resolve(root, "compose.yml")).text();
		const guide = await Bun.file(resolve(root, source)).text();
		const run =
			guide
				.split(new RegExp(`^## ${heading}\\r?$`, "m"))[1]
				?.split(/^## /m)[0] ?? "";
		const required = new Set(
			Array.from(
				compose.matchAll(/\$\{(KZ_[A-Z0-9_]+):\?/g),
				(match) => match[1],
			),
		);
		expect(required.size).toBeGreaterThan(0);
		expect(
			Array.from(required).filter((name) => !run.includes(`\`${name}\``)),
		).toEqual([]);
	},
);

test("the documented Compose image default stays release-managed and matches Compose", async () => {
	const compose = await Bun.file(resolve(root, "compose.yml")).text();
	const guide = await Bun.file(resolve(root, "src/README.md")).text();
	const versionRow = guide
		.split(/\r?\n/)
		.find((line) => /^\|\s*`KZ_VERSION`\s*\|/.test(line));
	const defaults = Array.from(
		compose.matchAll(/\$\{KZ_VERSION:-([^}]+)\}/g),
		(match) => match[1],
	);
	expect(defaults.length).toBeGreaterThan(0);
	for (const version of defaults)
		expect(versionRow).toContain(`default \`${version}\``);
	expect(versionRow).toContain("<!-- x-release-please-version -->");
	const config: {
		packages: Record<string, { "extra-files": string[] }>;
	} = await Bun.file(resolve(root, "release-please-config.json")).json();
	expect(config.packages["."]?.["extra-files"]).toContain("src/README.md");
});

test("local README links resolve", async () => {
	const missing: string[] = [];
	for (const source of ["README.md", "src/README.md"]) {
		const path = resolve(root, source);
		const content = await Bun.file(path).text();
		const links = Array.from(content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g));
		expect(links.length).toBeGreaterThan(0);
		for (const match of links) {
			const target = match[1];
			if (!target || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
			const local = decodeURIComponent(target.split("#")[0] ?? "");
			if (!(await stat(resolve(dirname(path), local)).catch(() => null)))
				missing.push(`${source}: ${target}`);
		}
	}
	expect(missing).toEqual([]);
});
