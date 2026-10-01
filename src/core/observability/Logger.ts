export class Logger {
	private readonly levels = { debug: 0, info: 1, warn: 2, error: 3 };
	constructor(
		private readonly level: "debug" | "info" | "warn" | "error" = "info",
	) {}
	write(
		level: "debug" | "info" | "warn" | "error",
		event: string,
		fields: { requestId?: string; code?: string; status?: number } = {},
	) {
		if (this.levels[level] < this.levels[this.level]) return;
		console.log(
			JSON.stringify({
				time: new Date().toISOString(),
				level,
				event,
				requestId: fields.requestId,
				code: fields.code,
				status: fields.status,
			}),
		);
	}
}
