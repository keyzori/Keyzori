import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/core/database/schema/*.ts",
	out: "./src/core/database/migrations",
});
