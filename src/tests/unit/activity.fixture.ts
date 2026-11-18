export const fixtureWatermark = {
	protocol: "invalidation-refetch" as const,
	stateConsistency: "non-atomic" as const,
	epoch: Bun.randomUUIDv7(),
	sequence: "0",
	retainedAfter: "0",
	cursor: "fixture-watermark",
};

export const fixtureReady = {
	type: "ready",
	schemaVersion: 1,
	protocol: fixtureWatermark.protocol,
	stateConsistency: fixtureWatermark.stateConsistency,
	resync: "/events/watermark",
	sessionExpiresAt: new Date(Date.now() + 900000).toISOString(),
	watermark: fixtureWatermark,
};
