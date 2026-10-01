import { TypeBoxValidator } from "elysia";
import type { $KeyFormat } from "../../types/security";
import { securityModel } from "./model";

export class KeyGenerator {
	static readonly defaultFormat = Object.freeze({
		prefix: "KZ",
		separator: "-",
		groups: 4,
		length: 8,
		charset: "uppercase",
	} satisfies $KeyFormat);

	private readonly validator = new TypeBoxValidator(securityModel.keyFormat);
	private readonly alphabets = {
		uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
		lowercase: "abcdefghijklmnopqrstuvwxyz0123456789",
		alphanumeric:
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
		hex: "0123456789abcdef",
	};

	master() {
		return `kz_key_${this.secret()}`;
	}

	api(id: string) {
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				id,
			)
		) {
			throw new Error("API key identity must be a UUIDv7");
		}
		const secret = this.secret();
		return { credential: `kz_key_${id}_${secret}`, secret };
	}

	validate(format: $KeyFormat) {
		if (!this.validator.Check(format))
			throw new Error("Invalid license key format");
		const alphabet = this.alphabets[format.charset];
		const characters = format.groups * format.length;
		const separators = format.groups - 1 + (format.prefix ? 1 : 0);
		const outputLength =
			Array.from(format.prefix).length +
			characters +
			separators * Array.from(format.separator).length;
		if (characters * Math.log2(alphabet.length) < 128 || outputLength > 4096) {
			throw new Error(
				"License key format must provide at least 128 bits and fit 4096 characters",
			);
		}
		return format;
	}

	license(format: $KeyFormat = KeyGenerator.defaultFormat) {
		this.validate(format);
		const alphabet = this.alphabets[format.charset];
		const threshold = 256 - (256 % alphabet.length);
		const count = format.groups * format.length;
		let random = "";
		while (random.length < count) {
			const bytes = crypto.getRandomValues(
				new Uint8Array(Math.min(4096, (count - random.length) * 2)),
			);
			for (const byte of bytes) {
				if (byte >= threshold) continue;
				random += alphabet.charAt(byte % alphabet.length);
				if (random.length === count) break;
			}
		}
		const groups = Array.from({ length: format.groups }, (_, index) =>
			random.slice(index * format.length, (index + 1) * format.length),
		);
		if (format.prefix) groups.unshift(format.prefix);
		return groups.join(format.separator);
	}

	private secret() {
		return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
			"hex",
		);
	}
}
