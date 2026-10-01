import { HttpError } from "./HttpError";
import { TypeBoxValidator } from "elysia";
import { httpModel } from "./model";

const timestampValidator = new TypeBoxValidator(httpModel.expiresAt);

export class InputPolicy {
	text(value: string) {
		if (!value.isWellFormed() || value.includes("\0"))
			throw new HttpError("INVALID_REQUEST");
	}
	jsonText(value: unknown) {
		const pending = [value];
		const seen = new WeakSet<object>();
		while (pending.length) {
			const item = pending.pop();
			if (typeof item === "string") this.text(item);
			else if (item && typeof item === "object" && !seen.has(item)) {
				seen.add(item);
				for (const [key, child] of Object.entries(item)) {
					this.text(key);
					pending.push(child);
				}
			}
		}
	}
	timestamp(value: string) {
		const offset = /[+-](\d{2}):\d{2}$/.exec(value);
		const date = new Date(value);
		if (
			!timestampValidator.Check(value) ||
			value.startsWith("0000-") ||
			(offset && Number(offset[1]) > 15) ||
			!Number.isFinite(date.getTime()) ||
			date.getUTCFullYear() < 1 ||
			date.getUTCFullYear() > 9999
		)
			throw new HttpError("INVALID_REQUEST");
		return date;
	}
	metadata(value?: unknown) {
		if (value === undefined) return;
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new HttpError("INVALID_REQUEST");
		const ancestors = new WeakSet<object>();
		let nodes = 0;
		let bytes = 0;
		const addBytes = (amount: number) => {
			bytes += amount;
			if (bytes > 1048576) throw new HttpError("INVALID_REQUEST");
		};
		const visit = (item: unknown, depth: number) => {
			if (depth > 16 || ++nodes > 4096) throw new HttpError("INVALID_REQUEST");
			if (item === null || typeof item === "boolean") {
				addBytes(item === null || item === true ? 4 : 5);
				return;
			}
			if (typeof item === "string" || typeof item === "number") {
				if (
					typeof item === "string"
						? !item.isWellFormed() ||
							item.includes("\0") ||
							Buffer.byteLength(item, "utf8") > 8192
						: !Number.isFinite(item)
				)
					throw new HttpError("INVALID_REQUEST");
				addBytes(Buffer.byteLength(JSON.stringify(item), "utf8"));
				return;
			}
			if (!item || typeof item !== "object" || ancestors.has(item))
				throw new HttpError("INVALID_REQUEST");
			const array = Array.isArray(item);
			const prototype = Object.getPrototypeOf(item);
			if (
				array
					? prototype !== Array.prototype || item.length > 256
					: prototype !== null && prototype !== Object.prototype
			)
				throw new HttpError("INVALID_REQUEST");
			const keys = Reflect.ownKeys(item);
			if (array ? keys.length !== item.length + 1 : keys.length > 64)
				throw new HttpError("INVALID_REQUEST");
			ancestors.add(item);
			addBytes(2);
			let entries = 0;
			for (const key of keys) {
				if (array && key === "length") continue;
				if (
					typeof key !== "string" ||
					!key ||
					!key.isWellFormed() ||
					key.includes("\0") ||
					Array.from(key).length > 128 ||
					["__proto__", "constructor", "prototype"].includes(key) ||
					(array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))
				)
					throw new HttpError("INVALID_REQUEST");
				const descriptor = Object.getOwnPropertyDescriptor(item, key);
				if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
					throw new HttpError("INVALID_REQUEST");
				if (entries++) addBytes(1);
				if (!array)
					addBytes(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
				visit(descriptor.value, depth + 1);
			}
			ancestors.delete(item);
		};
		visit(value, 0);
	}
	notes(value?: string | null) {
		if (value !== undefined && value !== null) this.text(value);
		if (value && Buffer.byteLength(value, "utf8") > 16384)
			throw new HttpError("INVALID_REQUEST");
	}
	ids(ids: string[]) {
		const canonical = ids.map((id) => id.toLowerCase());
		if (!canonical.length || new Set(canonical).size !== canonical.length)
			throw new HttpError("INVALID_REQUEST");
		return canonical.sort();
	}
	idempotency(value?: string | null, required = false) {
		if (!value) {
			if (required)
				throw new HttpError("INVALID_REQUEST", {
					idempotencyKey: "Idempotency-Key is required",
				});
			return;
		}
		if (!/^[\x21-\x7e]{1,256}$/.test(value))
			throw new HttpError("INVALID_REQUEST");
		return value;
	}
}
