import type { $Actor } from "./auth";
import type { $RequestContext } from "./http";

export type $AuditInput = $RequestContext & {
	actor: $Actor;
	action: string;
	targetType: string;
	targetId?: string;
	reason?: string;
	hardwareId?: string;
	before?: Record<string, unknown>;
	after?: Record<string, unknown>;
};
