import { HttpError } from "../../core/http/HttpError";

export class DecimalPolicy {
	value(value: number, precision: number, positive = false) {
		if (
			!Number.isFinite(value) ||
			value < 0 ||
			(positive && value === 0) ||
			!Number.isInteger(precision) ||
			precision < 0 ||
			precision > 6
		)
			throw new HttpError("INVALID_REQUEST");
		const text = value.toString();
		const [mantissa = "", exponent = "0"] = text.toLowerCase().split("e");
		const decimalPlaces = Math.max(
			0,
			(mantissa.split(".")[1]?.length ?? 0) - Number(exponent),
		);
		if (decimalPlaces > precision || value >= 10 ** (15 - precision))
			throw new HttpError("INVALID_REQUEST", {
				usage: "Number exceeds the configured meter precision or range",
			});
		return text;
	}
}
