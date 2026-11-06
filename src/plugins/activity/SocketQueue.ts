/** Bun's native queue is optional: an unavailable measurement is not zero bytes. */
export function transportBufferedBytes(socket: unknown): number | undefined {
	try {
		if (!socket || typeof socket !== "object") return;
		const raw = "raw" in socket ? socket.raw : socket;
		if (
			!raw ||
			typeof raw !== "object" ||
			!("getBufferedAmount" in raw) ||
			typeof raw.getBufferedAmount !== "function"
		)
			return;
		const bytes: unknown = raw.getBufferedAmount();
		return typeof bytes === "number" &&
			Number.isSafeInteger(bytes) &&
			bytes >= 0
			? bytes
			: undefined;
	} catch {
		return undefined;
	}
}
