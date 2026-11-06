import type { $Actor } from "./auth";
import type { $RequestContext } from "./http";

export type $AuditInput = $RequestContext & {
	actor: $Actor;
	action: string;
	targetType: string;
	targetId?: string;
	groupId?: string | null;
	/** All historical groups whose values occur in this record. */
	requiredGroupIds?: string[];
	requiresAllGroups?: boolean;
	reason?: string;
	hardwareId?: string;
	before?: Record<string, unknown>;
	after?: Record<string, unknown>;
};
