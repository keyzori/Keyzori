import { describe, expect, mock, test } from "bun:test";
import type { RedisClient } from "bun";
import { RedisSessionRepository } from "../infrastructure/repositories/RedisSessionRepository";

describe("RedisSessionRepository", () => {
	const binding = { ip: "203.0.113.10", deviceId: "device-1" };
	const bindingHash = new Bun.CryptoHasher("sha256")
		.update(`${binding.ip}\0${binding.deviceId}`)
		.digest("hex");

	test.each([1, -1] as const)(
		"maps registration result %i",
		async (redisResult) => {
			const send = mock(
				async (_command: string, _args: string[]): Promise<number> =>
					redisResult,
			);
			const repository = new RedisSessionRepository({
				send,
			} as unknown as RedisClient);
			const result = await repository.registerSession(
				"license-1",
				0,
				binding,
				45,
				2,
			);
			expect(result.status).toBe(
				redisResult === 1 ? "registered" : "limit-reached",
			);
			const [command, args] = send.mock.calls[0] ?? [];
			expect(command).toBe("EVAL");
			const token = args?.[4];
			if (!token) throw new Error("Missing generated session token");
			expect(args?.slice(1)).toEqual([
				"2",
				"license_sessions:license-1",
				`license_session:${token}`,
				token,
				"45",
				"2",
				"license_session:",
				`license-1|0|${bindingHash}`,
				"0",
			]);
		},
	);

	test("resolves and refreshes a token without rotating it", async () => {
		const send = mock(
			async (_command: string, _args: string[]): Promise<string> =>
				"license-1|0",
		);
		const repository = new RedisSessionRepository({
			send,
		} as unknown as RedisClient);
		expect(
			await repository.refreshSession("session-token", binding, 45),
		).toEqual({
			licenseId: "license-1",
			sessionRevision: 0,
			token: "session-token",
		});
		expect(send.mock.calls[0]?.[1]?.slice(1)).toEqual([
			"1",
			"license_session:session-token",
			bindingHash,
			"45",
			"license_sessions:",
			"session-token",
		]);
	});

	test("returns null for an invalid or binding-mismatched token", async () => {
		const repository = new RedisSessionRepository({
			send: mock(async () => ""),
		} as unknown as RedisClient);
		expect(
			await repository.refreshSession("session-token", binding, 45),
		).toBeNull();
		expect(await repository.removeSession("session-token", binding)).toBeNull();
	});

	test("removes one bound session and can terminate every license session", async () => {
		const send = mock(async (_command: string, args: string[]) =>
			args[1]?.includes("REMOVE_ALL") ? 0 : "license-1|0",
		);
		const repository = new RedisSessionRepository({
			send,
		} as unknown as RedisClient);
		expect(await repository.removeSession("session-token", binding)).toEqual({
			licenseId: "license-1",
			sessionRevision: 0,
			token: "session-token",
		});

		const terminateSend = mock(
			async (_command: string, _args: string[]): Promise<number> => 3,
		);
		const terminatingRepository = new RedisSessionRepository({
			send: terminateSend,
		} as unknown as RedisClient);
		expect(await terminatingRepository.removeAllSessions("license-1")).toBe(3);
		expect(terminateSend.mock.calls[0]?.[1]?.slice(1)).toEqual([
			"1",
			"license_sessions:license-1",
			"license_session:",
			"",
		]);

		await terminatingRepository.removeAllSessions("license-1", 3);
		expect(terminateSend.mock.calls[1]?.[1]?.slice(1)).toEqual([
			"1",
			"license_sessions:license-1",
			"license_session:",
			"3",
		]);
	});

	test("rejects unexpected Redis responses", async () => {
		const repository = new RedisSessionRepository({
			send: mock(async () => ({ invalid: true })),
		} as unknown as RedisClient);
		expect(
			repository.registerSession("license-1", 0, binding, 45, 1),
		).rejects.toThrow("invalid session registration result");
		expect(repository.refreshSession("token", binding, 45)).rejects.toThrow(
			"invalid session refresh result",
		);
		expect(repository.removeSession("token", binding)).rejects.toThrow(
			"invalid session removal result",
		);
		expect(repository.removeAllSessions("license-1")).rejects.toThrow(
			"invalid session termination result",
		);
	});
});
