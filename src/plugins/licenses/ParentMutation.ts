import type { $Principal } from "../../types/auth";
import type { $Transaction } from "../../types/database";

/** A write grant acknowledges identities; only current read authority permits parent snapshots. */
export function parentMutation<Row>(
	read: "groups:read" | "users:read",
	load: (tx: $Transaction) => Promise<{ principal: $Principal; rows: Row[] }>,
) {
	let readable = false;
	const states = new WeakMap<$Transaction, Row[]>();
	return {
		authorize: async (tx: $Transaction) => {
			const { principal, rows } = await load(tx);
			readable = principal.kind === "root" || principal.scopes.includes(read);
			states.set(tx, rows);
			return principal;
		},
		rows: (tx: $Transaction) => {
			const rows = states.get(tx);
			if (!rows)
				throw new Error(
					"Parent targets were not authorized in this transaction",
				);
			return rows;
		},
		view: <T extends { id: string }>(row: T) =>
			readable ? row : { id: row.id },
	};
}
