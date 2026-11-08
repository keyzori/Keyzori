export type $Principal =
	| { kind: "root"; id: "root"; name: "Root"; scopes: string[] }
	| {
			kind: "api";
			id: string;
			name: string;
			scopes: string[];
			/** Digest evidence used to reject requests authenticated before rotation. */
			credentialHash: string;
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
