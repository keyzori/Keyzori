export function hashUsageEventId(eventId: string): string {
	return new Bun.CryptoHasher("sha256").update(eventId).digest("hex");
}
