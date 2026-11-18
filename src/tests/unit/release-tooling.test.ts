import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { imageProvenance } from "../../scripts/image-provenance";
import { requirePrefix } from "../../../.github/scripts/migration-prefix";
import {
	manifest,
	promote,
	readCheckpoint,
	recordCheckpoint,
} from "../../../.github/scripts/release-images";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected test object");
	return Object.fromEntries(Object.entries(value));
}
async function draftGate(
	version: string,
	contract: unknown,
	tag = `v${version}`,
) {
	const workflow = object(
		Bun.YAML.parse(await Bun.file(".github/workflows/release.yml").text()),
	);
	const steps = object(object(workflow.jobs).release).steps;
	if (!Array.isArray(steps)) throw new Error("Release steps missing");
	const step = steps.map(object).find((entry) => entry.id === "artifacts");
	if (!step) throw new Error("Draft gate missing");
	const script = object(step.with).script;
	if (typeof script !== "string") throw new Error("Draft script missing");
	const outputs = new Map<string, unknown>();
	const sha = "a".repeat(40);
	await runInNewContext(`(async () => { ${script} })()`, {
		Buffer,
		process: { env: { RELEASE_TAG: tag } },
		context: { repo: { owner: "fixture", repo: "fixture" } },
		core: {
			setOutput: (key: string, value: unknown) => outputs.set(key, value),
		},
		github: {
			paginate: async () => [
				{ id: 1, tag_name: tag, draft: true, immutable: false },
			],
			rest: {
				git: { getRef: async () => ({ data: { object: { sha } } }) },
				repos: {
					listReleases: () => {},
					getCommit: async () => ({ data: { sha } }),
					compareCommitsWithBasehead: async () => ({
						data: { base_commit: { sha }, status: "identical" },
					}),
					getContent: async ({ path }: { path: string }) => {
						if (path === ".github/release-contract.json" && !contract)
							throw new Error("Contract not found");
						return {
							data: {
								type: "file",
								encoding: "base64",
								content: Buffer.from(
									JSON.stringify(
										path === "package.json" ? { version } : contract,
									),
								).toString("base64"),
							},
						};
					},
				},
				actions: {
					listWorkflowRuns: async () => ({
						data: { workflow_runs: [{ id: 1, conclusion: "success" }] },
					}),
				},
			},
		},
	});
	return outputs;
}

test("historical draft recovery rejects missing, binary-era and mismatched publication contracts", async () => {
	const contract: unknown = await Bun.file(
		".github/release-contract.json",
	).json();
	await expect(draftGate("2.0.3", undefined)).rejects.toThrow(
		"Contract not found",
	);
	await expect(draftGate("2.0.3", contract)).rejects.toThrow("incompatible");
	await expect(
		draftGate("3.0.0-beta.1", {
			...object(contract),
			distribution: "compiled-binaries",
		}),
	).rejects.toThrow("incompatible");
	await expect(
		draftGate("3.0.0-beta.1", contract, "v3.0.0-beta.2"),
	).rejects.toThrow("incompatible");
	const outputs = await draftGate("3.0.0-beta.1", contract);
	expect(outputs.get("sha")).toBe("a".repeat(40));
	expect(outputs.get("tag")).toBe("v3.0.0-beta.1");
});

test("image provenance binds the tested digest and explicit recovery source rather than the dispatch commit", async () => {
	const source = "b".repeat(40);
	const digest = `sha256:${"c".repeat(64)}`;
	const provenance = await imageProvenance({
		SOURCE_SHA: source,
		IMAGE_DIGEST: digest,
		TARGET_ARCH: "arm64",
		GITHUB_SHA: "a".repeat(40),
		PUBLICATION_WORKFLOW_SHA: "a".repeat(40),
		GITHUB_REPOSITORY: "fixture/keyzori",
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_RUN_ID: "1",
		GITHUB_RUN_ATTEMPT: "2",
		RELEASE_TAG: "v3.0.0-beta.1",
	});
	expect(provenance.buildDefinition.externalParameters).toMatchObject({
		source,
		imageDigest: digest,
		platform: "linux/arm64",
	});
	expect(provenance.buildDefinition.resolvedDependencies[0]).toMatchObject({
		digest: { gitCommit: source },
	});
	expect(provenance.buildDefinition.resolvedDependencies).toHaveLength(5);
	expect(provenance.runDetails.builder.id).toEndWith(`@${"a".repeat(40)}`);
	await expect(imageProvenance({ SOURCE_SHA: "main" })).rejects.toThrow(
		"immutable",
	);
});

test("the v3 migration prefix permits first-release bootstrap and appends only", () => {
	const tree = (time: number, hash: string) =>
		`040000 tree ${hash.repeat(40)}\t202611061050${time}_fixture`;
	const a = tree(11, "a"),
		b = tree(12, "b"),
		c = tree(13, "c");
	requirePrefix([], [a, b]);
	requirePrefix([a, b], [a, b, c]);
	for (const bad of [[a], [a, tree(12, "c")], [a, c, b], [tree(10, "d"), a, b]])
		expect(() => requirePrefix([a, b], bad)).toThrow();
});

test("a recorded release recovers partial promotion without replacing either tested image", async () => {
	const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
	const native = (arch: string) =>
		manifest(
			bytes({
				schemaVersion: 2,
				mediaType: "application/vnd.oci.image.manifest.v1+json",
				config: { arch },
			}),
		);
	const amd = native("amd64"),
		arm = native("arm64");
	const source = { sha: "a".repeat(40), tag: "v3.0.0-beta.9" };
	const recorded = { ...source, amd64: amd.digest, arm64: arm.digest };
	const notes = recordCheckpoint("Release notes.", recorded);
	expect(readCheckpoint(notes, source)).toEqual(recorded);
	expect(recordCheckpoint(notes, recorded)).toBe(notes);
	expect(() =>
		recordCheckpoint(notes, { ...recorded, arm64: native("other").digest }),
	).toThrow();
	expect(() =>
		readCheckpoint(notes, { ...source, sha: "b".repeat(40) }),
	).toThrow();
	const refs = new Map([
		[amd.digest, amd],
		[arm.digest, arm],
	]);
	const writes: string[] = [];
	let interrupt = true;
	const registry = {
		get: async (ref: string) => refs.get(ref) ?? null,
		put: async (tag: string, index: ReturnType<typeof manifest>) => {
			if (interrupt && writes.length) throw new Error("interrupted");
			expect(refs.has(tag)).toBe(false);
			writes.push(tag);
			refs.set(tag, index);
		},
	};
	await expect(promote(registry, recorded)).rejects.toThrow("interrupted");
	const original = refs.get(source.tag);
	interrupt = false;
	await promote(registry, recorded);
	await promote(registry, recorded);
	expect(writes).toEqual([source.tag, source.tag.slice(1)]);
	expect(refs.get(source.tag.slice(1))?.digest).toBe(original?.digest);
	// Both expected architecture names are present but the wrong digest is assigned.
	refs.delete(source.tag.slice(1));
	await expect(
		promote(registry, { ...recorded, amd64: arm.digest, arm64: amd.digest }),
	).rejects.toThrow("Conflicting tested digest");
	expect(writes).toHaveLength(2);
});
