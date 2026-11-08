import { resolve } from "node:path";

const exactVersion =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads direct installed manifests, catching stale root packages despite a current lockfile. */
export async function verifyInstalledDependencies(
	root: string,
	manifest: unknown,
) {
	if (!record(manifest)) throw new Error("package.json must contain an object");
	const pins = new Map<string, string>();
	for (const field of ["dependencies", "devDependencies"]) {
		const entries = manifest[field];
		if (entries === undefined) continue;
		if (!record(entries))
			throw new Error(
				`package.json ${field} must contain exact dependency versions`,
			);
		for (const [name, version] of Object.entries(entries)) {
			if (name.length > 214 || !packageName.test(name))
				throw new Error("package.json contains an invalid dependency name");
			if (typeof version !== "string" || !exactVersion.test(version))
				throw new Error(`${name}: expected an exact dependency version`);
			if (pins.has(name) && pins.get(name) !== version)
				throw new Error(`${name}: conflicting dependency versions`);
			pins.set(name, version);
		}
	}
	const mismatches: string[] = [];
	for (const [name, expected] of pins) {
		const file = Bun.file(resolve(root, "node_modules", name, "package.json"));
		let actual = "<missing>";
		if (await file.exists()) {
			actual = "<invalid>";
			try {
				const installed: unknown = await file.json();
				if (
					record(installed) &&
					typeof installed.version === "string" &&
					exactVersion.test(installed.version)
				)
					actual = installed.version;
			} catch {
				/* Report only package identity/version, never manifest contents. */
			}
		}
		if (actual !== expected)
			mismatches.push(`${name}: expected ${expected}; installed ${actual}`);
	}
	if (mismatches.length) throw new Error(mismatches.join("\n"));
	return pins.size;
}

/** Checks the selected runtime without installing or changing it. */
export async function doctor() {
	const root = resolve(import.meta.dir, "../..");
	const expected = (
		await Bun.file(resolve(root, ".bun-revision")).text()
	).trim();
	const version = (await Bun.file(resolve(root, ".bun-version")).text()).trim();
	const manifest: unknown = await Bun.file(
		resolve(root, "package.json"),
	).json();
	const actual = `${Bun.version}+${Bun.revision}`;
	const child = Bun.spawn([process.execPath, "--revision"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const reported = (await new Response(child.stdout).text()).trim();
	const exit = await child.exited;
	if (exit !== 0) throw new Error(`Cannot inspect Bun runtime (${actual})`);
	console.log(`Bun expected: ${expected}; selected: ${reported}`);
	if (!record(manifest) || manifest.packageManager !== `bun@${version}`)
		throw new Error("packageManager and .bun-version disagree");
	if (reported !== expected)
		throw new Error(
			"The selected Bun revision differs from the repository pin",
		);
	console.log(
		`Installed direct dependency pins verified: ${await verifyInstalledDependencies(root, manifest)}`,
	);
}

if (import.meta.main) await doctor();
