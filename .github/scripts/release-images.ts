import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

const platforms = ["amd64", "arm64"] as const;
type Arch = (typeof platforms)[number];
type Source = { sha: string; tag: string };
export type Checkpoint = Source & Record<Arch, string>;
const marker = "<!-- keyzori-tested-images-v1 ";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const oci = "application/vnd.oci.image.";
const docker = "application/vnd.docker.distribution.manifest.";
const indexTypes = [`${oci}index.v1+json`, `${docker}list.v2+json`];
const nativeTypes = [`${oci}manifest.v1+json`, `${docker}v2+json`];
function object(value: unknown): Record<string, unknown> {
	assert.ok(
		value && typeof value === "object" && !Array.isArray(value),
		"Invalid release metadata",
	);
	return Object.fromEntries(Object.entries(value));
}
function digest(value: unknown): string {
	assert.ok(
		typeof value === "string" && digestPattern.test(value),
		"Invalid image digest",
	);
	return value;
}
function checkpoint(input: unknown, source: Source): Checkpoint {
	const value = object(input);
	assert.equal(value.sha, source.sha, "Wrong checkpoint commit");
	assert.equal(value.tag, source.tag, "Wrong checkpoint tag");
	const amd64 = digest(value.amd64),
		arm64 = digest(value.arm64);
	assert.notEqual(
		amd64,
		arm64,
		"Native architectures must have distinct digests",
	);
	return { ...source, amd64, arm64 };
}
export function readCheckpoint(
	body: string,
	source: Source,
): Checkpoint | null {
	if (!body.includes("<!-- keyzori-tested-images-")) return null;
	const lines = body
		.split(/\r?\n/)
		.filter((line) => line.includes("<!-- keyzori-tested-images-"));
	assert.equal(lines.length, 1, "Ambiguous image checkpoint");
	const line = lines[0];
	assert.ok(
		typeof line === "string" &&
			line.startsWith(marker) &&
			line.endsWith(" -->"),
		"Invalid image checkpoint",
	);
	return checkpoint(JSON.parse(line.slice(marker.length, -4)), source);
}
export function recordCheckpoint(body: string, expected: Checkpoint) {
	const existing = readCheckpoint(body, expected);
	if (existing) {
		assert.deepEqual(
			existing,
			expected,
			"Refusing to replace tested image digests",
		);
		return body;
	}
	return `${body.trimEnd()}\n\n${marker}${JSON.stringify(expected)} -->`;
}

const hash = (bytes: Uint8Array) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function manifest(bytes: Uint8Array) {
	const document = object(JSON.parse(new TextDecoder().decode(bytes)));
	assert.equal(document.schemaVersion, 2);
	assert.ok(typeof document.mediaType === "string");
	return { bytes, digest: hash(bytes), type: document.mediaType, document };
}
type Manifest = ReturnType<typeof manifest>;
type Registry = {
	get: (ref: string) => Promise<Manifest | null>;
	put: (tag: string, value: Manifest) => Promise<void>;
};
function verifyIndex(value: Manifest, expected: Checkpoint) {
	assert.ok(
		indexTypes.includes(value.type),
		"Version tag is not a multi-platform index",
	);
	const entries = value.document.manifests;
	assert.ok(
		Array.isArray(entries) && entries.length === 2,
		"Unexpected image platform count",
	);
	for (const arch of platforms) {
		const native: Record<string, unknown>[] = entries
			.map(object)
			.filter((entry) => {
				const platform = object(entry.platform);
				return platform.os === "linux" && platform.architecture === arch;
			});
		assert.equal(native.length, 1, `Missing or duplicated linux/${arch}`);
		assert.equal(
			native[0]?.digest,
			expected[arch],
			`Conflicting tested digest for linux/${arch}`,
		);
	}
}

/** Read both aliases before any write. Repair a missing alias with the exact original index bytes. */
export async function promote(registry: Registry, record: Checkpoint) {
	const tags = [record.tag, record.tag.slice(1)];
	const existing = await Promise.all(tags.map((tag) => registry.get(tag)));
	let index: Manifest | undefined;
	for (const value of existing) {
		if (!value) continue;
		verifyIndex(value, record);
		if (index)
			assert.equal(
				value.digest,
				index.digest,
				"Conflicting public index digests",
			);
		index = value;
	}
	if (!index) {
		const descriptors = await Promise.all(
			platforms.map(async (arch) => {
				const value = await registry.get(record[arch]);
				assert.ok(
					value &&
						nativeTypes.includes(value.type) &&
						value.digest === record[arch],
					`Recorded native linux/${arch} manifest is unavailable`,
				);
				return {
					mediaType: value.type,
					digest: value.digest,
					size: value.bytes.length,
					platform: { os: "linux", architecture: arch },
				};
			}),
		);
		index = manifest(
			Buffer.from(
				JSON.stringify({
					schemaVersion: 2,
					mediaType: indexTypes[0],
					manifests: descriptors,
				}),
			),
		);
	}
	for (const [i, tag] of tags.entries()) {
		if (!existing[i]) {
			const immediatelyBefore = await registry.get(tag);
			if (immediatelyBefore)
				assert.equal(
					immediatelyBefore.digest,
					index.digest,
					"Public tag changed during promotion",
				);
			else await registry.put(tag, index);
		}
	}
	for (const tag of tags) {
		const value = await registry.get(tag);
		assert.ok(value, "Published version tag missing");
		verifyIndex(value, record);
		assert.equal(value.digest, index.digest, "Published version tag changed");
	}
	return { index, tags };
}

function required(key: string) {
	const value = process.env[key];
	if (!value) throw new Error(`Missing ${key}`);
	return value;
}
async function ghcr(name: string): Promise<Registry> {
	const auth = Buffer.from(
		`${required("GITHUB_ACTOR")}:${required("GH_TOKEN")}`,
	).toString("base64");
	const scope = new URLSearchParams({
		service: "ghcr.io",
		scope: `repository:${name}:pull,push`,
	});
	const response = await fetch(`https://ghcr.io/token?${scope}`, {
		headers: { Authorization: `Basic ${auth}` },
	});
	assert.ok(response.ok, `Registry authentication failed (${response.status})`);
	const token = object(await response.json()).token;
	assert.ok(typeof token === "string" && token.length);
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: [...indexTypes, ...nativeTypes].join(","),
	};
	const uri = (ref: string) =>
		`https://ghcr.io/v2/${name}/manifests/${encodeURIComponent(ref)}`;
	return {
		async get(ref) {
			const result = await fetch(uri(ref), { headers });
			if (result.status === 404) {
				const errors = object(await result.json()).errors;
				assert.ok(
					Array.isArray(errors) &&
						errors.some((error) => object(error).code === "MANIFEST_UNKNOWN"),
					"Unconfirmed registry tag absence",
				);
				return null;
			}
			assert.ok(result.ok, `Registry read failed (${result.status})`);
			const value = manifest(new Uint8Array(await result.arrayBuffer()));
			assert.equal(
				value.digest,
				result.headers.get("docker-content-digest"),
				"Registry content digest mismatch",
			);
			return value;
		},
		async put(tag, value) {
			const result = await fetch(uri(tag), {
				method: "PUT",
				headers: {
					...headers,
					"Content-Type": value.type,
					"If-None-Match": "*",
				},
				body: Buffer.from(value.bytes),
			});
			assert.equal(
				result.status,
				201,
				"Registry rejected create-only version publication",
			);
			assert.equal(result.headers.get("docker-content-digest"), value.digest);
		},
	};
}

async function main() {
	const source = { sha: required("SOURCE_SHA"), tag: required("RELEASE_TAG") };
	assert.match(source.sha, /^[a-f0-9]{40}$/);
	assert.match(source.tag, /^v3\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
	const repo = required("GITHUB_REPOSITORY");
	const name = `${repo.split("/")[0]?.toLowerCase()}/server`;
	assert.match(name, /^[a-z0-9][a-z0-9-]*\/server$/);
	const id = required("RELEASE_ID");
	assert.match(id, /^[1-9]\d*$/);
	const api = `${required("GITHUB_API_URL")}/repos/${repo}`;
	const request = async (path: string, body?: unknown) => {
		const result = await fetch(api + path, {
			method: body ? "PATCH" : "GET",
			headers: {
				Authorization: `Bearer ${required("GH_TOKEN")}`,
				"User-Agent": "keyzori-image-release",
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		assert.ok(result.ok, `Draft request failed (${result.status})`);
		return object(await result.json());
	};
	const release = await request(`/releases/${id}`);
	assert.ok(
		release.draft === true &&
			!release.immutable &&
			release.tag_name === source.tag,
		"Expected an unpublished matching draft",
	);
	assert.equal(
		(await request(`/commits/${encodeURIComponent(`tags/${source.tag}`)}`)).sha,
		source.sha,
		"Release tag changed",
	);
	const body = typeof release.body === "string" ? release.body : "";
	const stored = readCheckpoint(body, source);
	const output = (key: string, value: string) =>
		appendFile(required("GITHUB_OUTPUT"), `${key}=${value}\n`);
	const mode = Bun.argv[2];
	if (mode === "plan") {
		await output("record", stored ? JSON.stringify(stored) : "");
	} else if (mode === "record") {
		const prior = process.env.PLANNED_RECORD;
		let record: Checkpoint;
		if (prior) {
			record = checkpoint(JSON.parse(prior), source);
			assert.deepEqual(
				stored,
				record,
				"Draft checkpoint changed after planning",
			);
		} else {
			const native = async (arch: Arch) => {
				const text = (await Bun.file(`digests/${arch}.txt`).text()).trim();
				const prefix = `ghcr.io/${name}@`;
				assert.ok(
					text.startsWith(prefix),
					"Unexpected native image repository",
				);
				return digest(text.slice(prefix.length));
			};
			record = checkpoint(
				{
					...source,
					amd64: await native("amd64"),
					arm64: await native("arm64"),
				},
				source,
			);
			const updated = recordCheckpoint(body, record);
			if (updated !== body) {
				const saved = await request(`/releases/${id}`, { body: updated });
				assert.ok(saved.draft === true && typeof saved.body === "string");
				assert.deepEqual(readCheckpoint(saved.body, source), record);
			}
		}
		await output("record", JSON.stringify(record));
	} else if (mode === "promote") {
		const expected = checkpoint(JSON.parse(required("TESTED_RECORD")), source);
		assert.deepEqual(
			stored,
			expected,
			"Refusing promotion without matching durable checkpoint",
		);
		const { index, tags } = await promote(await ghcr(name), expected);
		await Bun.write("published-images/index.json", index.bytes);
		const lines =
			tags.map((tag) => `ghcr.io/${name}:${tag} ${index.digest}`).join("\n") +
			"\n";
		await Bun.write("published-images/tags.txt", lines);
		await appendFile(required("GITHUB_STEP_SUMMARY"), lines);
	} else throw new Error("Unknown image release operation");
}
if (import.meta.main) await main();
