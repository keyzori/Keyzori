import { timingSafeEqual } from "node:crypto";

export class SecretHasher {
	hash(input: string) {
		return new Bun.CryptoHasher("sha256").update(input).digest("hex");
	}

	matches(input: string, expectedHash: string) {
		if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
		return timingSafeEqual(
			Buffer.from(this.hash(input), "hex"),
			Buffer.from(expectedHash, "hex"),
		);
	}
}
