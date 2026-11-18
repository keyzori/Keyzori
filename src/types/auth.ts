export type $Principal =
	| { kind: "root"; id: "root"; name: "Root"; scopes: string[] }
	| {
			kind: "api";
			id: string;
			name: string;
			scopes: string[];
			/** Digest evidence used to reject requests authenticated before rotation. */
			credentialHash: string;
			/** Exact database generation, JSON-safe for activity cursor bindings. */
			grantGeneration: string;
			expiresAt: Date | null;
			/** Includes ungrouped licences when true. */
			allGroups: boolean;
			/** Selected group IDs; never grants access to ungrouped licences. */
			groupIds: string[];
	  };

export type $Actor = {
	kind: "root" | "api" | "license" | "system" | "anonymous";
	id: string | null;
	name: string | null;
};
