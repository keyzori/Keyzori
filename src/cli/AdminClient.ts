import type { Environment } from "../shared/Config.ts";
import { AppError } from "../shared/errors.ts";

export class AdminClient {
	readonly url: URL;
	private readonly key: string;
	constructor(env: Environment) {
		this.url = new URL(env.KEYZORI_URL ?? "http://127.0.0.1:3000");
		if (
			!["http:", "https:"].includes(this.url.protocol) ||
			this.url.username ||
			this.url.password ||
			this.url.search ||
			this.url.hash ||
			this.url.pathname !== "/"
		)
			throw new Error(
				"KEYZORI_URL must be an HTTP(S) origin without credentials.",
			);
		this.key = env.KEYZORI_ADMIN_KEY ?? "";
	}
	async request(
		method: string,
		path: string,
		body?: unknown,
		query: Record<string, string> = {},
	) {
		if (this.key.length < 32)
			throw new Error("KEYZORI_ADMIN_KEY must contain at least 32 characters.");
		if (!path.startsWith("/") || path.startsWith("//"))
			throw new Error("Invalid admin path.");
		const url = new URL(path, this.url);
		if (url.origin !== this.url.origin)
			throw new Error("Admin requests must stay on the configured origin.");
		for (const [key, value] of Object.entries(query))
			url.searchParams.set(key, value);
		const response = await fetch(url, {
			method,
			headers: { "X-Admin-Key": this.key, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		});
		const value: unknown = await response.json();
		if (!response.ok) {
			if (
				value &&
				typeof value === "object" &&
				"error" in value &&
				value.error &&
				typeof value.error === "object" &&
				"code" in value.error &&
				"message" in value.error &&
				typeof value.error.code === "string" &&
				typeof value.error.message === "string"
			)
				throw new AppError(
					value.error.code,
					value.error.message,
					response.status,
				);
			throw new AppError(
				"HTTP_ERROR",
				`Server returned HTTP ${response.status}.`,
				response.status,
			);
		}
		return value;
	}
}
