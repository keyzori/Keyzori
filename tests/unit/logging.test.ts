import { expect, test } from "bun:test";

test("application logging uses the bar and box layouts without leaking secrets", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`import { createLogger } from "./src/shared/logging.ts";
			const logger = createLogger();
			logger.error("session lic_private");
			logger.notif("Listening on 127.0.0.1:3000\\nPlugins: none", {
				layout: "box",
				colors: false,
				box: { topRight: "Keyzori", bottomLeft: "ready" },
			});`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [code, output, error] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);

	expect(code).toBe(0);
	expect(error).toContain("▌ × keyzori › session [REDACTED]");
	expect(output).toContain("NOTIF");
	expect(output).toContain("Keyzori");
	expect(output).toContain("│ Listening on 127.0.0.1:3000");
	expect(output).toContain("└─ ready");
	expect(`${output}${error}`).not.toContain("lic_private");
});
