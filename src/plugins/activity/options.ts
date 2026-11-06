export type ActivityOptions = {
	sessionLifetimeMs?: number;
	subscribeTimeoutMs?: number;
	leaseMs?: number;
	leaseSafetyMs?: number;
	renewEveryMs?: number;
	pollIntervalMs?: number;
	replayIntervalMs?: number;
	batchBytes?: number;
};

export function activityOptions(options: ActivityOptions) {
	const value = {
		sessionLifetimeMs: 900000,
		subscribeTimeoutMs: 10000,
		leaseMs: 30000,
		leaseSafetyMs: 5000,
		renewEveryMs: 5000,
		pollIntervalMs: 1000,
		replayIntervalMs: 25,
		batchBytes: 131072,
		...options,
	};
	for (const [key, number] of Object.entries(value))
		if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647)
			throw new Error(`Invalid activity option: ${key}`);
	if (
		value.renewEveryMs >= value.leaseMs - value.leaseSafetyMs ||
		value.pollIntervalMs >= value.leaseMs - value.leaseSafetyMs ||
		value.batchBytes < 34816 ||
		value.batchBytes > 131072
	)
		throw new Error("Invalid activity delivery bounds");
	return value;
}
