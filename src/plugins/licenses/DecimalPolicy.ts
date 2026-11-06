import { HttpError } from "../../core/http/HttpError";

export class DecimalPolicy {
	value(value: string, precision: number, positive = false) {
		if (
			typeof value !== "string" ||
			!/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/.test(value) ||
			(positive && /^0(?:\.0+)?$/.test(value)) ||
			!Number.isInteger(precision) ||
			precision < 0 ||
			precision > 6
		)
			throw new HttpError("INVALID_REQUEST");
		const [whole = "", fraction = ""] = value.split(".");
		const trimmed = fraction.replace(/0+$/, "");
		if (trimmed.length > precision || whole.length > 15 - precision)
			throw new HttpError("INVALID_REQUEST", {
				usage: "Number exceeds the configured meter precision or range",
			});
		return trimmed ? `${whole}.${trimmed}` : whole;
	}
}
