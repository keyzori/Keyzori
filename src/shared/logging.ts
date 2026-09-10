import { Logger, type LogCallOptions } from "@lilsnibbi/logger";
import { redact } from "./security.ts";

type AppLogOptions = Omit<LogCallOptions, "raw">;

export class AppLogger {
	private readonly output: Logger;
	constructor(name = "keyzori") {
		this.output = new Logger({
			name,
			level: "NOTIF",
			layout: "bar",
		});
	}
	notif(event: string, options?: AppLogOptions) {
		this.output.notif(redact(event), { ...options, raw: false });
	}
	error(event: string, options?: AppLogOptions) {
		this.output.error(redact(event), { ...options, raw: false });
	}
}

export const createLogger = (name = "keyzori") => new AppLogger(name);
