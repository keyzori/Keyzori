import type { errors } from "../core/http/errors";

export type $ErrorCode = keyof typeof errors;
export type $RequestContext = {
	requestId: string;
	clientIp: string;
	deadlineAt?: number;
};

export type $TrackedRequest = {
	requestId: string;
	startedAt: number;
	deadlineAt: number;
};
