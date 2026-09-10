import type { ActivityRepository } from "./ActivityRepository.ts";
import type { activityQuery } from "./schemas.ts";
import { collection, pagination } from "../shared/schemas.ts";
import { AppError } from "../shared/errors.ts";

export class ActivityService {
	constructor(
		private readonly repository: ActivityRepository,
		private readonly retentionDays: number,
	) {}
	async list(query: typeof activityQuery.infer) {
		this.validate(query);
		const page = pagination(query);
		return collection(await this.repository.list(query, page), page);
	}
	async stats(query: typeof activityQuery.infer) {
		this.validate(query);
		return {
			items: await this.repository.stats(query),
			retentionDays: this.retentionDays,
		};
	}
	async prune() {
		const deleted = await this.repository.prune(
			new Date(Date.now() - this.retentionDays * 86400000),
		);
		return { deleted };
	}
	private validate(query: typeof activityQuery.infer) {
		if (query.from && query.to && new Date(query.from) > new Date(query.to))
			throw new AppError("INVALID_RANGE", "The start must precede the end.");
	}
}
