import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

type Step = {
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, unknown>;
};
type Job = {
	name?: string;
	needs?: string | string[];
	uses?: string;
	if?: string;
	permissions?: Record<string, string>;
	steps?: Step[];
	"continue-on-error"?: boolean;
	strategy?: { matrix?: { include?: { suite: string; name: string }[] } };
	with?: Record<string, unknown>;
};
type Workflow = { jobs: Record<string, Job> };
const root = resolve(import.meta.dir, "../..");
const workflow = async (name: string) =>
	Bun.YAML.parse(
		await Bun.file(resolve(root, ".github/workflows", name)).text(),
	) as Workflow;

test("CI gates Docker on all checks at the same source commit", async () => {
	const file = await workflow("ci.yml");
	const image = file.jobs.docker;
	const checks = file.jobs.checks;
	expect(image?.uses).toBe("./.github/workflows/docker.yml");
	expect(checks?.uses).toBe("./.github/workflows/checks.yml");
	expect([image?.needs].flat()).toContain("checks");
	expect(image?.with?.ref).toBe(checks?.with?.ref);
	expect(image?.if).toBeUndefined();
	expect(image?.["continue-on-error"]).toBeUndefined();
	for (const [id, job] of Object.entries(file.jobs)) {
		if (!["docker", "required"].includes(id))
			expect([job.needs].flat()).not.toContain("docker");
	}
});
test("Release Please publishes the created release image", async () => {
	const file = await workflow("release.yml");
	const steps = file.jobs.release?.steps ?? [];
	const image = file.jobs.docker;
	const release = steps.find((step) =>
		step.uses?.startsWith("googleapis/release-please-action@"),
	);
	expect(release?.uses).toBe(
		"googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7",
	);
	expect(release?.with?.["config-file"]).toBe("release-please-config.json");
	expect(release?.with?.["manifest-file"]).toBe(
		".release-please-manifest.json",
	);
	expect(image?.uses).toBe("./.github/workflows/docker.yml");
	expect([image?.needs].flat()).toContain("release");
	expect(image?.if).toBe("needs.release.outputs.release_created == 'true'");
	expect(image?.permissions).toEqual({
		contents: "write",
		packages: "write",
	});
	expect(image?.with).toEqual({
		ref: `\${{ needs.release.outputs.sha }}`,
		release_tag: `\${{ needs.release.outputs.tag_name }}`,
		publish: true,
	});
	expect(
		steps.some((step) => /npm publish|docker push/.test(step.run ?? "")),
	).toBe(false);
	const config = (await Bun.file(
		resolve(root, "release-please-config.json"),
	).json()) as {
		packages: Record<string, Record<string, unknown>>;
	};
	expect(config.packages["."]?.["release-type"]).toBe("node");
	expect(config.packages["."]?.["bump-minor-pre-major"]).toBe(true);
	expect(existsSync(resolve(root, ".github/workflows/tag.yml"))).toBe(false);
	expect(existsSync(resolve(root, ".github/workflows/promote.yml"))).toBe(
		false,
	);
});
test("CI exposes one stable required check that cannot hide skipped failures", async () => {
	const file = await workflow("ci.yml");
	const required = file.jobs.required;
	expect(file.jobs.docker?.name).toBe("Docker");
	expect(required?.name).toBe("Required checks");
	expect(required?.if).toContain("always()");
	expect([required?.needs].flat().toSorted()).toEqual(["checks", "docker"]);
	const command = required?.steps?.[0]?.run ?? "";
	expect(command).toContain('CHECKS_RESULT}" != "success"');
	expect(command).toContain('CONTAINER_RESULT}" != "success"');
});
test("checks run independently and real infrastructure jobs cannot silently skip", async () => {
	const file = await workflow("checks.yml");
	for (const id of [
		"typecheck",
		"lint",
		"migrations",
		"metadata",
		"unit",
		"integration",
		"compose",
	]) {
		const job = file.jobs[id];
		expect(job).toBeDefined();
		expect(job?.["continue-on-error"]).toBeUndefined();
		expect(job?.needs).toBeUndefined();
	}
	expect(
		file.jobs.integration?.strategy?.matrix?.include
			?.map((entry) => entry.suite)
			.toSorted(),
	).toEqual(["cli", "database", "http", "plugins", "services"]);
	expect(
		file.jobs.integration?.steps?.some((step) =>
			step.run?.startsWith("bun run test:integration"),
		),
	).toBe(true);
	for (const job of Object.values(file.jobs))
		expect(job.steps?.some((step) => step.run?.includes("docker build"))).toBe(
			false,
		);
});
test("the container job uses an accurate name and tests one image before publication", async () => {
	const file = await workflow("docker.yml");
	expect(file.jobs.image?.name).toBe("Build and smoke test");
	const steps = file.jobs.image?.steps ?? [];
	const builds = steps.filter((step) => step.run?.includes("docker build"));
	expect(builds).toHaveLength(1);
	const build = steps.findIndex((step) => step.run?.includes("docker build"));
	const smoke = steps.findIndex((step) => step.run === "bun run docker:smoke");
	const publish = steps.findIndex((step) => step.run?.includes("docker push"));
	expect(smoke).toBeGreaterThan(build);
	expect(publish).toBeGreaterThan(smoke);
	expect(steps[publish]?.if).toBe("inputs.publish");
	expect(steps[publish]?.run).toContain("docker tag keyzori-rebuild");
	expect(
		steps.slice(publish).some((step) => step.run?.includes("docker build")),
	).toBe(false);
});
test("Compose isolates storage and waits for healthy dependencies before serving", async () => {
	const config = Bun.YAML.parse(
		await Bun.file(resolve(root, "compose.yml")).text(),
	) as {
		services: Record<
			string,
			{
				image: string;
				ports?: string[];
				depends_on?: Record<string, { condition: string }>;
				command?: string[];
				restart?: string;
				read_only?: boolean;
				healthcheck?: { disable?: boolean };
				volumes?: string[];
			}
		>;
	};
	const { server, migrate, postgres, redis } = config.services;
	expect(migrate).toBeUndefined();
	expect(server?.read_only).toBe(true);
	expect(server?.command).toEqual(["serve"]);
	expect(server?.depends_on?.postgres?.condition).toBe("service_healthy");
	expect(server?.depends_on?.redis?.condition).toBe("service_healthy");
	expect(postgres?.ports).toBeUndefined();
	expect(redis?.ports).toBeUndefined();
	expect(redis?.command).toContain("noeviction");
	expect(redis?.command).not.toContain("allkeys-lru");
	expect(postgres?.volumes?.length).toBeGreaterThan(0);
	expect(redis?.volumes?.length).toBeGreaterThan(0);
	expect(existsSync(resolve(root, "dev.docker-compose.yml"))).toBe(false);
	expect(existsSync(resolve(root, "prod.docker-compose.yml"))).toBe(false);
});
test("Docker installs production dependencies and runs source as a non-root user", async () => {
	const dockerfile = await Bun.file(resolve(root, "Dockerfile")).text();
	expect(dockerfile).toContain(
		"--production --frozen-lockfile --ignore-scripts",
	);
	expect(dockerfile).toContain('ENTRYPOINT ["bun", "src/main.ts"]');
	expect(dockerfile).toMatch(/^USER bun$/m);
	expect(dockerfile).not.toMatch(/bun build|bun run build|COPY.*dist/);
	const ignore = await Bun.file(resolve(root, ".dockerignore")).text();
	expect(ignore).toContain("**/node_modules");
	expect(ignore).toContain("**/.env");
});
