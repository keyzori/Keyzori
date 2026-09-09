export type SessionRegistrationResult =
	| { status: "registered"; token: string }
	| { status: "limit-reached" };

export interface SessionBinding {
	ip: string;
	deviceId: string;
}

export interface ResolvedSession {
	licenseId: string;
	sessionRevision: number;
	token: string;
}

export interface ISessionRepository {
	registerSession(
		licenseId: string,
		sessionRevision: number,
		binding: SessionBinding,
		ttlSeconds: number,
		maxSessions: number,
	): Promise<SessionRegistrationResult>;
	refreshSession(
		sessionToken: string,
		binding: SessionBinding,
		ttlSeconds: number,
	): Promise<ResolvedSession | null>;
	removeSession(
		sessionToken: string,
		binding: SessionBinding,
	): Promise<ResolvedSession | null>;
	removeAllSessions(
		licenseId: string,
		preserveFromRevision?: number,
	): Promise<number>;
}
