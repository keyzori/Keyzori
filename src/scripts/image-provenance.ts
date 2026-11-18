/** Records the checked-out source, not the workflow dispatch commit used for recovery. */
export async function imageProvenance(
	environment: Record<string, string | undefined>,
) {
	const source = environment.SOURCE_SHA;
	const workflow = environment.PUBLICATION_WORKFLOW_SHA;
	const digest = environment.IMAGE_DIGEST;
	const releaseTag = environment.RELEASE_TAG;
	const arch = environment.TARGET_ARCH;
	const repository = environment.GITHUB_REPOSITORY;
	const server = environment.GITHUB_SERVER_URL;
	const run = environment.GITHUB_RUN_ID;
	const attempt = environment.GITHUB_RUN_ATTEMPT;
	if (
		!source ||
		!/^[a-f0-9]{40}$/.test(source) ||
		!workflow ||
		!/^[a-f0-9]{40}$/.test(workflow) ||
		!digest ||
		!/^sha256:[a-f0-9]{64}$/.test(digest) ||
		!releaseTag ||
		!/^v3\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(releaseTag) ||
		!arch ||
		!["amd64", "arm64"].includes(arch) ||
		!repository ||
		!server ||
		!run ||
		!attempt
	)
		throw new Error("Missing immutable image provenance inputs");
	const files = await Promise.all(
		["bun.lock", "src/Dockerfile", ".bun-version", ".bun-revision"].map(
			async (path) => ({
				uri: `${server}/${repository}/blob/${source}/${path}`,
				digest: {
					sha256: new Bun.CryptoHasher("sha256")
						.update(await Bun.file(path).arrayBuffer())
						.digest("hex"),
				},
			}),
		),
	);
	return {
		buildDefinition: {
			buildType: `${server}/${repository}/blob/${workflow}/.github/workflows/docker.yml`,
			externalParameters: {
				source,
				platform: `linux/${arch}`,
				imageDigest: digest,
				releaseTag,
			},
			internalParameters: {
				bunRevision: (await Bun.file(".bun-revision").text()).trim(),
				publicationWorkflowCommit: workflow,
			},
			resolvedDependencies: [
				{ uri: `git+${server}/${repository}`, digest: { gitCommit: source } },
				...files,
			],
		},
		runDetails: {
			builder: {
				id: `${server}/${repository}/.github/workflows/docker.yml@${workflow}`,
			},
			metadata: {
				invocationId: `${server}/${repository}/actions/runs/${run}/attempts/${attempt}`,
			},
		},
	};
}

if (import.meta.main)
	await Bun.write(
		"image.provenance.json",
		`${JSON.stringify(await imageProvenance(Bun.env), null, 2)}\n`,
	);
