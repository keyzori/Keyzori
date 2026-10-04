import { RequestTracker } from "./RequestTracker";
import { HttpError } from "./HttpError";
import { InputPolicy } from "./InputPolicy";
import type { AuthService } from "../auth/AuthService";
import type { ClientIpResolver } from "./ClientIpResolver";
import type { RateLimiter } from "./RateLimiter";
import type { SettingsService } from "../../plugins/settings/SettingsService";
import type { $Principal } from "../../types/auth";

export class RequestService {
	constructor(
		private readonly auth: AuthService,
		private readonly ip: ClientIpResolver,
		private readonly limiter: RateLimiter,
		private readonly settings: SettingsService,
		private readonly tracker = new RequestTracker(),
	) {}
	async authorize(request: Request, peer: string | null, scope: string) {
		const started = this.tracker.begin(request);
		this.checkDeadline(started.deadlineAt);
		const context = {
			...started,
			clientIp: await this.ip.resolve(
				peer,
				request.headers,
				started.deadlineAt,
			),
		};
		const settings = await this.settings.read(undefined, context.deadlineAt);
		let principal: $Principal;
		try {
			principal = await this.auth.authenticate(
				request.headers.get("authorization"),
				context.deadlineAt,
			);
		} catch (error) {
			if (
				settings.rateLimitEnabled &&
				error instanceof HttpError &&
				error.status === 401
			)
				await this.limiter.check(
					`invalid:${context.clientIp}`,
					settings.adminRequestsPerMinute,
					context.deadlineAt,
				);
			throw error;
		}
		if (settings.rateLimitEnabled)
			await this.limiter.check(
				`${principal.kind}:${principal.id}:${context.clientIp}`,
				settings.adminRequestsPerMinute,
				context.deadlineAt,
			);
		this.checkDeadline(context.deadlineAt);
		this.auth.require(principal, scope);
		return {
			...context,
			principal,
			idempotencyKey: new InputPolicy().idempotency(
				request.headers.get("idempotency-key"),
			),
		};
	}
	async runtime(request: Request, peer: string | null) {
		const started = this.tracker.begin(request);
		this.checkDeadline(started.deadlineAt);
		const context = {
			...started,
			clientIp: await this.ip.resolve(
				peer,
				request.headers,
				started.deadlineAt,
			),
		};
		const settings = await this.settings.read(undefined, context.deadlineAt);
		if (settings.rateLimitEnabled)
			await this.limiter.check(
				`validate:${context.clientIp}`,
				settings.validateRequestsPerMinute,
				context.deadlineAt,
			);
		this.checkDeadline(context.deadlineAt);
		return {
			...context,
			idempotencyKey: new InputPolicy().idempotency(
				request.headers.get("idempotency-key"),
			),
		};
	}
	private checkDeadline(deadlineAt: number) {
		if (Date.now() >= deadlineAt) throw new HttpError("SERVICE_UNAVAILABLE");
	}
}
