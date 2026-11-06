import { actions, scopes, type $Action } from "./scopes";

export class ScopeService {
	private readonly known = new Set<string>(scopes);
	private readonly concrete = new Set<string>(actions);

	validate(grants: readonly string[]): $Action[] {
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
		return actions.filter(
			(action) => unique.has(action) || unique.has(`${action.split(":")[0]}:*`),
		);
	}

	/** Persisted grants must already contain only known, concrete actions. */
	validStored(grants: readonly string[]): boolean {
		return (
			new Set(grants).size === grants.length &&
			grants.every((grant) => this.concrete.has(grant))
		);
	}

	allows(grants: readonly string[], required: string) {
		return (
			this.concrete.has(required) &&
			this.validStored(grants) &&
			grants.includes(required)
		);
	}

	authorize(grants: readonly string[], required: string, isRoot = false) {
		if (!isRoot && !this.allows(grants, required))
			throw new Error("Insufficient scope");
	}
}
