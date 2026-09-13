import { AppError } from "../shared/errors.ts";

// Keep one busy license from occupying every SQL connection while waiting for
// its row lock. Database locks remain authoritative across server replicas.
export class SessionWorkQueue {
	private readonly pending = new Map<
		string,
		{ tail: Promise<void>; count: number }
	>();
	private total = 0;
	constructor(
		private readonly perKey = 64,
		private readonly maximum = 1024,
	) {}
	async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.pending.get(key);
		if ((previous?.count ?? 0) >= this.perKey || this.total >= this.maximum)
			throw new AppError(
				"UNAVAILABLE",
				"The service is busy. Try again later.",
				503,
			);
		let release!: () => void;
		const tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entry = previous ?? { tail: Promise.resolve(), count: 0 };
		const wait = entry.tail;
		entry.tail = tail;
		entry.count++;
		this.total++;
		this.pending.set(key, entry);
		await wait;
		try {
			return await operation();
		} finally {
			entry.count--;
			this.total--;
			if (!entry.count) this.pending.delete(key);
			release();
		}
	}
}
