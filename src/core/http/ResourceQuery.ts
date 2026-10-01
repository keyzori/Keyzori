import { and, eq, ilike, or, sql } from "drizzle-orm";
import { HttpError } from "./HttpError";
import type { $QueryColumns, $ResourceSort } from "../../types/query";

export class ResourceQuery {
	readonly id;
	readonly limit;
	readonly where;
	readonly order;
	readonly sort: $ResourceSort;
	private readonly direction;
	constructor(
		query: URLSearchParams,
		columns: $QueryColumns,
		defaultLimit = 10,
	) {
		for (const key of query.keys())
			if (query.getAll(key).length !== 1)
				throw new HttpError("INVALID_REQUEST");
		this.id = query.get("id");
		if (this.id && !this.uuid(this.id)) throw new HttpError("INVALID_REQUEST");
		const limit = query.get("limit");
		if (limit && !/^[1-9]\d*$/.test(limit))
			throw new HttpError("INVALID_REQUEST");
		this.limit = limit === null ? defaultLimit : Number(limit);
		if (
			!Number.isSafeInteger(this.limit) ||
			this.limit < 1 ||
			this.limit > 2147483646
		)
			throw new HttpError("INVALID_REQUEST");
		const sort = query.get("sort") ?? "createdAt";
		if (sort !== "createdAt" && sort !== "updatedAt" && sort !== "expiresAt")
			throw new HttpError("INVALID_REQUEST");
		const field = columns[sort];
		if (!field) throw new HttpError("INVALID_REQUEST");
		const column = sql`date_trunc('milliseconds', ${field})`;
		this.sort = sort;
		const direction = query.get("direction") ?? "desc";
		if (direction !== "asc" && direction !== "desc")
			throw new HttpError("INVALID_REQUEST");
		this.direction = direction;
		const filters = [];
		for (const [key, value] of query) {
			if (["limit", "sort", "direction", "cursor"].includes(key)) continue;
			if (key === "id") {
				filters.push(eq(columns.id, value));
				continue;
			}
			if (key.startsWith("metadata.") || key.startsWith("metadataNumber.")) {
				if (!columns.metadata) throw new HttpError("INVALID_REQUEST");
				const numeric = key.startsWith("metadataNumber.");
				const name = key.slice(numeric ? 15 : 9);
				if (!name || Array.from(name).length > 128)
					throw new HttpError("INVALID_REQUEST");
				if (
					numeric &&
					(!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value) ||
						!Number.isFinite(Number(value)))
				)
					throw new HttpError("INVALID_REQUEST");
				filters.push(
					numeric
						? sql`${columns.metadata}->${name} = to_jsonb(${value}::numeric)`
						: sql`${columns.metadata}->${name} = to_jsonb(${value}::text)`,
				);
				continue;
			}
			if (
				key === "enabled" ||
				key === "hasExpiry" ||
				key === "hasDeviceLimit"
			) {
				if (value !== "true" && value !== "false")
					throw new HttpError("INVALID_REQUEST");
				const field =
					key === "enabled"
						? columns.enabled
						: key === "hasExpiry"
							? columns.expiresAt
							: columns.deviceLimit;
				if (!field) throw new HttpError("INVALID_REQUEST");
				filters.push(
					key === "enabled"
						? eq(field, value === "true")
						: value === "true"
							? sql`${field} is not null`
							: sql`${field} is null`,
				);
				continue;
			}
			if (key === "userId" || key === "itemId") {
				const field = columns[key];
				if (!field || !this.uuid(value)) throw new HttpError("INVALID_REQUEST");
				filters.push(eq(field, value));
				continue;
			}
			if (
				[
					"expiresBefore",
					"expiresAfter",
					"createdBefore",
					"createdAfter",
				].includes(key)
			) {
				const field = key.startsWith("expires")
					? columns.expiresAt
					: columns.createdAt;
				if (
					!field ||
					!/^\d{4}-\d{2}-\d{2}T/.test(value) ||
					!Number.isFinite(Date.parse(value))
				)
					throw new HttpError("INVALID_REQUEST");
				filters.push(
					key.endsWith("Before")
						? sql`${field} < ${value}::timestamptz`
						: sql`${field} > ${value}::timestamptz`,
				);
				continue;
			}
			if (key === "search") {
				if (!value || value.length > 256)
					throw new HttpError("INVALID_REQUEST");
				const pattern = `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
				filters.push(
					or(
						sql`${columns.id}::text = ${value}`,
						columns.name ? ilike(columns.name, pattern) : undefined,
						columns.notes ? ilike(columns.notes, pattern) : undefined,
					),
				);
				continue;
			}
			throw new HttpError("INVALID_REQUEST");
		}
		const cursor = query.get("cursor");
		if (cursor) {
			let decoded: unknown;
			try {
				decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
			} catch {
				throw new HttpError("INVALID_REQUEST");
			}
			if (
				!decoded ||
				typeof decoded !== "object" ||
				!("id" in decoded) ||
				typeof decoded.id !== "string" ||
				!this.uuid(decoded.id) ||
				!("value" in decoded) ||
				(decoded.value !== null &&
					(typeof decoded.value !== "string" ||
						!Number.isFinite(Date.parse(decoded.value)))) ||
				!("sort" in decoded) ||
				decoded.sort !== sort ||
				!("direction" in decoded) ||
				decoded.direction !== this.direction
			)
				throw new HttpError("INVALID_REQUEST");
			const idComparison =
				this.direction === "asc"
					? sql`${columns.id} > ${decoded.id}`
					: sql`${columns.id} < ${decoded.id}`;
			filters.push(
				decoded.value === null
					? and(sql`${column} is null`, idComparison)
					: or(
							this.direction === "asc"
								? sql`${column} > ${decoded.value}::timestamptz`
								: sql`${column} < ${decoded.value}::timestamptz`,
							and(sql`${column} = ${decoded.value}::timestamptz`, idComparison),
							sql`${column} is null`,
						),
			);
		}
		this.where = and(...filters);
		this.order =
			this.direction === "asc"
				? [sql`${column} asc nulls last`, sql`${columns.id} asc`]
				: [sql`${column} desc nulls last`, sql`${columns.id} desc`];
	}
	cursor(row: {
		id: string;
		createdAt: Date;
		updatedAt: Date;
		expiresAt?: Date | null;
	}) {
		return Buffer.from(
			JSON.stringify({
				id: row.id,
				value: row[this.sort]?.toISOString() ?? null,
				sort: this.sort,
				direction: this.direction,
			}),
		).toString("base64url");
	}
	private uuid(value: string) {
		return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
			value,
		);
	}
}
