import { t } from "elysia";
import { HttpError } from "./HttpError";
import { InputPolicy } from "./InputPolicy";

/** These writes target timestamp(3); filters can still express finer cutoffs. */
export const instantModel = t.String({
	format: "date-time",
	pattern: "^[^.]+(?:\\.[0-9]{1,3}(?:[zZ]|[+-][0-9]{2}:[0-9]{2}))?$",
	maxLength: 40,
	description:
		"Absolute instant with an explicit offset and at most millisecond precision.",
});

const policy = new InputPolicy();
export function writeInstant(value: string) {
	if (/\.\d{4}/.test(value)) throw new HttpError("INVALID_REQUEST");
	return policy.timestamp(value);
}
