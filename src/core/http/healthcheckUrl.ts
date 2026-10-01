import { isIP } from "node:net";

export function healthcheckUrl(config: { host: string; port: number }) {
	if (!isIP(config.host) || config.host.includes("%"))
		throw new Error("KZ_API_HOST must be an IP address");
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
		throw new Error("KZ_API_PORT must be an integer from 1 to 65535");
	const address =
		config.host === "0.0.0.0"
			? "127.0.0.1"
			: config.host === "::"
				? "::1"
				: config.host;
	const host = address.includes(":") ? `[${address}]` : address;
	return `http://${host}:${config.port}/health`;
}
