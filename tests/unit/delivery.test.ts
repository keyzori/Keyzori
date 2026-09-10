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
	needs?: string | string[];
	uses?: string;
	if?: string;
	steps?: Step[];
	"continue-on-error"?: boolean;
	strategy?: { matrix?: { suite?: string[] } };
	with?: Record<string, unknown>;
};
type Workflow = { jobs: Record<string, Job> };
const root = resolve(import.meta.dir, "../..");
const workflow = async (name: string) =>
	Bun.YAML.parse(
		await Bun.file(resolve(root, ".github/workflows", name)).text(),
	) as Workflow;

test.each(["ci.yml", "release.yml"])(
	"%s gates Docker on all checks at the same source commit",
	async (name) => {
		const file = await workflow(name);
		const image = file.jobs.docker;
		const checks = file.jobs.checks;
		expect(image?.uses).toBe("./.github/workflows/docker.yml");
		expect(checks?.uses).toBe("./.github/workflows/checks.yml");
		expect([image?.needs].flat()).toContain("checks");
		expect(image?.with?.ref).toBe(checks?.with?.ref);
		expect(image?.if).toBeUndefined();
		expect(image?.["continue-on-error"]).toBeUndefined();
		for (const [id, job] of Object.entries(file.jobs)) {
			if (id !== "docker") expect([job.needs].flat()).not.toContain("docker");
		}
	},
);
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
	expect(file.jobs.integration?.strategy?.matrix?.suite?.toSorted()).toEqual([
		"cli",
		"database",
		"http",
		"plugins",
		"services",
	]);
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
test("the final job smoke-tests one image before any publication", async () => {
	const file = await workflow("docker.yml");
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
test("Compose isolates storage, shares the runtime image, and requires successful migrations", async () => {
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
	expect(server?.image).toBe(migrate?.image);
	expect(server?.read_only).toBe(true);
	expect(migrate?.read_only).toBe(true);
	expect(migrate?.command).toEqual(["migrate"]);
	expect(migrate?.restart).toBe("no");
	expect(migrate?.healthcheck?.disable).toBe(true);
	expect(server?.depends_on?.migrate?.condition).toBe(
		"service_completed_successfully",
	);
	expect(migrate?.depends_on?.postgres?.condition).toBe("service_healthy");
	expect(server?.depends_on?.redis?.condition).toBe("service_healthy");
	expect(postgres?.ports).toBeUndefined();
	expect(redis?.ports).toBeUndefined();
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
