import { Elysia } from "elysia";
import type { $Requests } from "../../types/application";
import type { Access } from "./operations";

export const guard = (requests: $Requests, scope: Exclude<Access, "public">) =>
	new Elysia({ normalize: false }).derive(async ({ request, server, set }) => {
		const operation = await requests.authorize(
			request,
			server?.requestIP(request)?.address ?? null,
			scope,
		);
		set.headers["X-Request-Id"] = operation.requestId;
		return { operation };
	});
