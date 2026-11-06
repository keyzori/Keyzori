import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { verifyInstalledDependencies } from "../../scripts/doctor";

test("doctor checks actual scoped/unscoped installed versions and rejects stale, missing or invalid manifests", async () => {
	const root = await mkdtemp(join(tmpdir(), "keyzori-doctor-"));
	const target = resolve(root);
	if (!relative(resolve(tmpdir()), target).startsWith("keyzori-doctor-"))
		throw new Error("Unsafe doctor fixture path");
	const manifest = {
		dependencies: { typebox: "1.4.4" },
		devDependencies: { "@scope/test": "2.0.0-beta.4" },
	};
	try {
		await Bun.write(
			join(root, "node_modules/typebox/package.json"),
			JSON.stringify({ version: "1.4.4" }),
		);
		await Bun.write(
			join(root, "node_modules/@scope/test/package.json"),
			JSON.stringify({ version: "2.0.0-beta.4" }),
		);
		await expect(verifyInstalledDependencies(root, manifest)).resolves.toBe(2);
		await Bun.write(
			join(root, "node_modules/typebox/package.json"),
			JSON.stringify({ version: "1.4.2" }),
		);
		await expect(verifyInstalledDependencies(root, manifest)).rejects.toThrow(
			"typebox: expected 1.4.4; installed 1.4.2",
		);
		await expect(
			verifyInstalledDependencies(root, { dependencies: { absent: "1.0.0" } }),
		).rejects.toThrow("absent: expected 1.0.0; installed <missing>");
		await Bun.write(
			join(root, "node_modules/typebox/package.json"),
			JSON.stringify({ version: "PRIVATE_MANIFEST_CONTENT" }),
		);
		await expect(
			verifyInstalledDependencies(root, {
				dependencies: manifest.dependencies,
			}),
		).rejects.toThrow("typebox: expected 1.4.4; installed <invalid>");
	} finally {
		await rm(target, { recursive: true, force: true });
	}
});
