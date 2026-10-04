import { validationCodes } from "./codes";
import type { $ValidationCode } from "../../types/validation";

export class Decision extends Error {
	constructor(readonly code: $ValidationCode) {
		super(validationCodes[code]);
	}
	response() {
		return { code: this.code, reason: validationCodes[this.code] };
	}
}
