import { Assert } from "typebox/value";
import type { TSchema } from "typebox";

/** Checks response JSON without converting, cleaning or discarding fields. */
export async function checkedJSON<const Schema extends TSchema>(
	response: Response,
	schema: Schema,
) {
	const value = await response.json();
	Assert(schema, value);
	return value;
}
