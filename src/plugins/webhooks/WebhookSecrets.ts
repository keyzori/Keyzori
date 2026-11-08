import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
} from "node:crypto";
import { HttpError } from "../../core/http/HttpError";

/** Recoverable signing secrets are encrypted under a separate operator key. */
export class WebhookSecrets {
	constructor(private readonly encryptionKey?: string) {}
	private key() {
		if (!this.encryptionKey || !/^[a-f0-9]{64}$/i.test(this.encryptionKey))
			throw new HttpError("SERVICE_UNAVAILABLE");
		return Buffer.from(this.encryptionKey, "hex");
	}
	issue() {
		const secret = randomBytes(32).toString("hex");
		return {
			secret,
			signingKeyId: Bun.randomUUIDv7(),
			secretCiphertext: this.encrypt(secret),
		};
	}
	encrypt(secret: string) {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
		cipher.setAAD(Buffer.from("keyzori-webhook-secret:v1"));
		const encrypted = Buffer.concat([
			cipher.update(secret, "utf8"),
			cipher.final(),
		]);
		return [
			"v1",
			iv.toString("base64url"),
			cipher.getAuthTag().toString("base64url"),
			encrypted.toString("base64url"),
		].join(".");
	}
	decrypt(value: string) {
		const key = this.key();
		try {
			const [version, nonce, tag, encrypted, extra] = value.split(".");
			if (
				version !== "v1" ||
				!nonce ||
				!tag ||
				!encrypted ||
				extra !== undefined
			)
				throw new Error("format");
			const iv = Buffer.from(nonce, "base64url");
			const authenticationTag = Buffer.from(tag, "base64url");
			if (iv.length !== 12 || authenticationTag.length !== 16)
				throw new Error("format");
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAAD(Buffer.from("keyzori-webhook-secret:v1"));
			decipher.setAuthTag(authenticationTag);
			const secret = Buffer.concat([
				decipher.update(Buffer.from(encrypted, "base64url")),
				decipher.final(),
			]).toString("utf8");
			if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("format");
			return secret;
		} catch {
			throw new HttpError("SERVICE_UNAVAILABLE");
		}
	}
	sign(encrypted: string, timestamp: string, deliveryId: string, body: string) {
		return createHmac("sha256", Buffer.from(this.decrypt(encrypted), "hex"))
			.update(`${timestamp}.${deliveryId}.${body}`)
			.digest("hex");
	}
}
