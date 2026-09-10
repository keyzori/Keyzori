import { describe, expect, spyOn, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { Application } from "../../src/application/Application.ts";
import { Config } from "../../src/shared/Config.ts";
import { root } from "../helpers/TestContext.ts";

describe.skipIf(!integrationAvailable)("lifecycle guards", () => {
	test("start cannot run twice and concurrent stops execute cleanup once", async () => {
		const ctx = await new TestContext().start();
		let calls = 0;
		ctx.app.app.onStop(async () => {
			calls++;
			await Bun.sleep(10);
		});
		try {
			await expect(ctx.app.start()).rejects.toThrow("cannot be started twice");
			const first = ctx.app.stop();
			expect(ctx.app.stop()).toBe(first);
			await first;
			expect(calls).toBe(1);
			expect(ctx.app.state.ready).toBe(false);
			await expect(ctx.app.start()).rejects.toThrow("cannot be started twice");
			await expect(ctx.app.migrate()).rejects.toThrow(
				"cannot be started twice",
			);
		} finally {
			await ctx.close();
		}
	});
	test("a failed cleanup hook does not skip remaining hooks or close clients early", async () => {
		const ctx = await new TestContext().start();
		let finished = false;
		const close = spyOn(ctx.app.services, "close");
		const log = spyOn(ctx.app.services.logger, "error").mockImplementation(
			() => {},
		);
		ctx.app.app.onStop(() => {
			throw new Error("forced cleanup failure");
		});
		ctx.app.app.onStop(async () => {
			await Bun.sleep(15);
			expect(close).not.toHaveBeenCalled();
			await ctx.app.services.database.ping();
			finished = true;
		});
		try {
			await expect(ctx.app.stop()).rejects.toThrow("Plugin cleanup failed");
			expect(finished).toBe(true);
			expect(close).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalledWith("plugin.cleanup_failed");
		} finally {
			close.mockRestore();
			log.mockRestore();
			ctx.app = new Application(new Config(ctx.env), root);
			await ctx.close();
		}
	});
	test("application identity without its journal is refused without erasing data", async () => {
		const ctx = await new TestContext().start();
		const customer = await ctx.customer();
		const url = ctx.env.KEYZORI_DATABASE_URL;
		if (!url) throw new Error("Missing test URL");
		await ctx.app.services.database
			.sql`ALTER TABLE keyzori_migrations.core RENAME TO saved_core`;
		try {
			await expect(ctx.restart()).rejects.toThrow(
				"without its migration journal",
			);
			const rows = await ctx.control.unsafe("SELECT 1");
			expect(rows).toHaveLength(1);
		} finally {
			const { SQL } = await import("bun");
			const repair = new SQL(url);
			try {
				const [row] =
					await repair`SELECT id FROM customers WHERE id = ${customer.id}`;
				expect(row.id).toBe(customer.id);
				await repair`ALTER TABLE keyzori_migrations.saved_core RENAME TO core`;
			} finally {
				await repair.close();
			}
			await ctx.restart();
			await ctx.close();
		}
	});
});
