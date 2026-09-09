import { isIP } from "node:net";

export function normalizeIpAddress(value: string): string | null {
	const address = value.trim();
	const family = isIP(address);
	if (family === 4) {
		return address
			.split(".")
			.map((part) => String(Number(part)))
			.join(".");
	}
	if (family !== 6) return null;
	try {
		const hostname = new URL(`http://[${address}]/`).hostname;
		const normalized = hostname.slice(1, -1).toLowerCase();
		const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
		if (!mapped) return normalized;
		const high = Number.parseInt(mapped[1] as string, 16);
		const low = Number.parseInt(mapped[2] as string, 16);
		return `::ffff:${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
	} catch {
		return null;
	}
}
