import type { $Principal } from "./auth";
import type { $RequestContext } from "./http";

export type $Operation = $RequestContext & {
	principal: $Principal;
	idempotencyKey?: string;
};
