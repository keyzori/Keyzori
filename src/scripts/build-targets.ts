export const buildTargets = {
	"linux-x64": "bun-linux-x64",
	"linux-arm64": "bun-linux-arm64",
	"windows-x64": "bun-windows-x64",
	"darwin-x64": "bun-darwin-x64",
	"darwin-arm64": "bun-darwin-arm64",
} as const satisfies Record<string, Bun.Build.CompileTarget>;

export function compileTarget(target: string): Bun.Build.CompileTarget {
	if (!Object.hasOwn(buildTargets, target))
		throw new Error(`Unknown build target: ${target}`);
	return buildTargets[target as keyof typeof buildTargets];
}
