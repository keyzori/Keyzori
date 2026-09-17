import { expect, mock, test } from "bun:test";
import {
	SessionService,
	type SessionServiceDependencies,
} from "../../src/sessions/SessionService.ts";

test.each(["cleanup", "commit", "audit"])(
	"terminate-all handles %s failure at the transaction boundary",
	async (stage) => {
		let committed = false;
		const failure = new Error(`forced ${stage} failure`);
		const removeAll = mock(async () => {
			expect(committed).toBe(true);
			throw failure;
		});
		const error = mock(() => {});
		const service = new SessionService({
			database: {
				orm: {
					transaction: async (operation: (tx: unknown) => Promise<number>) => {
						const revision = await operation({});
						if (stage === "commit") throw failure;
						committed = true;
						return revision;
					},
				},
			},
			licenses: {
				lock: async () => ({ policyRevision: 7 }),
				update: async () => {},
			},
			activity: {
				write: async () => {
					if (stage === "audit") throw failure;
				},
			},
			repository: { removeAll },
			logger: { error },
		} as unknown as SessionServiceDependencies);
		if (stage === "cleanup") {
			await expect(service.terminateAll("license-id")).resolves.toEqual({
				terminated: true,
			});
			expect(removeAll).toHaveBeenCalledWith("license-id", 7);
			expect(error).toHaveBeenCalledWith(
				"session.bulk_cleanup_failed_ttl_cleanup_pending",
			);
		} else {
			await expect(service.terminateAll("license-id")).rejects.toBe(failure);
			expect(removeAll).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		}
	},
);
