import { RequestTracker } from "./RequestTracker";
import { HttpError } from "./HttpError";
import { InputPolicy } from "./InputPolicy";
import type { AuthService } from "../auth/AuthService";
import type { ClientIpResolver } from "./ClientIpResolver";
import type { RateLimiter } from "./RateLimiter";
import type { SettingsService } from "../../plugins/settings/SettingsService";
import type { $Principal } from "../../types/auth";
import type { $Operation } from "../../types/operation";
import type { Access } from "./operations";

export class RequestService {
	private readonly admitted = new WeakMap<Request, Promise<$Operation>>();
	constructor(
		private readonly auth: AuthService,
		private readonly ip: ClientIpResolver,
		private readonly limiter: RateLimiter,
		private readonly settings: SettingsService,
		private readonly tracker = new RequestTracker(),
		private readonly maxInFlight = 128,
		private readonly peerRequestsPerMinute = 600,
	) {}
	/** Runs before parsing or database access. Proxies share the direct-peer budget. */
	async admit(request: Request, peer: string | null) {
		const context = this.tracker.begin(request);
		if (this.tracker.draining || this.tracker.active > this.maxInFlight)
			throw new HttpError("SERVICE_UNAVAILABLE");
		if (!peer) throw new HttpError("SERVICE_UNAVAILABLE");
		if (
			request.url.length > 8192 ||
			Array.from(request.headers).reduce(
				(size, [key, value]) => size + key.length + value.length,
				0,
			) > 16384
		)
			throw new HttpError("INVALID_REQUEST");
		if (new URL(request.url).pathname === "/live") return;
		await this.limiter.check(
			`peer:${peer}`,
			this.peerRequestsPerMinute,
			context.deadlineAt,
		);
	}
	async authorize(
		request: Request,
		peer: string | null,
		scope: Exclude<Access, "public">,
	) {
		let pending = this.admitted.get(request);
		if (!pending) {
			pending = this.authenticateRequest(request, peer);
			this.admitted.set(request, pending);
		}
		const operation = await pending;
		this.checkDeadline(operation.deadlineAt ?? Infinity);
		this.auth.require(operation.principal, scope);
		return operation;
	}
	private async authenticateRequest(request: Request, peer: string | null) {
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
