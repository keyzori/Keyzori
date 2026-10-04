import { scopes } from "./scopes";

export class ScopeService {
	private readonly known = new Set<string>(scopes);

	validate(grants: readonly string[]) {
		const unique = new Set(grants);
		if (
			unique.size !== grants.length ||
			grants.some((grant) => !this.known.has(grant))
		) {
			throw new Error("Unknown or duplicate scopes");
		}
		for (const grant of grants) {
			if (!grant.endsWith(":*") && unique.has(`${grant.split(":")[0]}:*`)) {
				throw new Error("Overlapping scopes");
			}
		}
		return [...grants];
	}

	allows(grants: readonly string[], required: string) {
		if (!this.known.has(required)) return false;
		return (
			grants.includes(required) ||
			grants.includes(`${required.split(":")[0]}:*`)
		);
	}

	authorize(grants: readonly string[], required: string, isRoot = false) {
		if (!isRoot && !this.allows(grants, required))
			throw new Error("Insufficient scope");
	}
}
