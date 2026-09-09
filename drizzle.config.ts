import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url:
			process.env.KEYZORI_DATABASE_URL ?? "postgresql://localhost:5432/keyzori",
	},
});
