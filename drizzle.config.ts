import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/*/tables.ts",
	out: "./migrations",
});
