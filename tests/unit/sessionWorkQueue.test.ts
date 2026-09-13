import { expect, test } from "bun:test";
import { SessionWorkQueue } from "../../src/sessions/SessionWorkQueue.ts";

test("a blocked license does not delay another license and failures release slots", async () => {
	const queue = new SessionWorkQueue(2, 3);
	const gate = Promise.withResolvers<void>();
	const order: number[] = [];
	const first = queue
		.run("busy", async () => {
			await gate.promise;
			order.push(1);
			throw new Error("rollback");
		})
		.catch((error: unknown) => error);
	const second = queue.run("busy", async () => {
		order.push(2);
		return "next";
	});
	await expect(queue.run("busy", async () => "overload")).rejects.toMatchObject(
		{ code: "UNAVAILABLE", status: 503 },
	);
	await expect(queue.run("other", async () => "healthy")).resolves.toBe(
		"healthy",
	);
	expect(order).toEqual([]);
	gate.resolve();
	expect(await first).toMatchObject({ message: "rollback" });
	await expect(second).resolves.toBe("next");
	expect(order).toEqual([1, 2]);
	await expect(queue.run("busy", async () => "recovered")).resolves.toBe(
		"recovered",
	);
});

test("total admitted work stays bounded across different licenses", async () => {
	const queue = new SessionWorkQueue(2, 2),
		gate = Promise.withResolvers<void>();
	const first = queue.run("one", () => gate.promise),
		second = queue.run("two", () => gate.promise);
	await expect(queue.run("three", async () => {})).rejects.toMatchObject({
		status: 503,
	});
	gate.resolve();
	await Promise.all([first, second]);
	await expect(queue.run("three", async () => 3)).resolves.toBe(3);
});
