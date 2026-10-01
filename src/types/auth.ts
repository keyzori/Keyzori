export type $Principal =
	| { kind: "root"; id: "root"; name: "Root"; scopes: string[] }
	| { kind: "api"; id: string; name: string; scopes: string[] }
	| {
			kind: "license";
			id: string;
			name: "License";
			scopes: string[];
			userId: string | null;
			itemId: string | null;
			credentialHash: string;
	  };

export type $Actor = {
	kind: "root" | "api" | "license" | "system" | "anonymous";
	id: string | null;
	name: string | null;
};
