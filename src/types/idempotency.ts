import type { $Principal } from "./auth";
import type { $Transaction } from "./database";
import type { $Action } from "../core/auth/scopes";

export type $ReceiptAuthority = {
	scope: $Action | "root";
	groupIds: (string | null)[];
	allGroups?: boolean;
	ownerId?: string;
	scopes?: $Action[];
};

export type $AdminOptions<T> = {
	topology?: "read" | "write";
	secretIds?: (result: T) => string[];
	/** Recheck action and every target's group before either mutation or replay. */
	authorize?: (tx: $Transaction) => Promise<$Principal>;
	/** Current action authentication precedes replay; live targets are needed only for new work. */
	scope?: $Action | "root";
	authority?: (
		tx: $Transaction,
		principal: $Principal,
	) => Promise<Omit<$ReceiptAuthority, "scope">>;
};
