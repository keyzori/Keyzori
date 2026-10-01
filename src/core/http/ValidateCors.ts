import type { $Settings } from "../../types/application";

export class ValidateCors {
	private readonly permitted = new WeakSet<Request>();
	constructor(private readonly settings: $Settings) {}
	async prepare(request: Request, deadlineAt?: number) {
		if (new URL(request.url).pathname !== "/validate") return;
		const origin = request.headers.get("origin");
		if (!origin) return;
		const { corsOrigins } = await this.settings.read(undefined, deadlineAt);
		if (corsOrigins.includes("*") || corsOrigins.includes(origin))
			this.permitted.add(request);
	}
	allows(request: Request) {
		return this.permitted.has(request);
	}
}
