import { Elysia } from "elysia";
import { AppError } from "./errors.ts";
import { equalSecret } from "./security.ts";

export function adminGuard(key: string) {
	return new Elysia({
		name: "keyzori-admin-guard",
		seed: key,
		detail: { security: [{ adminKey: [] }] },
	}).onBeforeHandle({ as: "scoped" }, ({ request }) => {
		if (!equalSecret(request.headers.get("x-admin-key") ?? "", key))
			throw new AppError(
				"UNAUTHORIZED",
				"A valid X-Admin-Key is required.",
				401,
			);
	});
}
export type AdminGuard = ReturnType<typeof adminGuard>;
