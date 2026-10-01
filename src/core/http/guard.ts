import { Elysia } from "elysia";
import type { $Requests } from "../../types/application";

export const guard = (requests: $Requests, scope: string) =>
	new Elysia({ normalize: false }).derive(async ({ request, server, set }) => {
		const operation = await requests.authorize(
			request,
			server?.requestIP(request)?.address ?? null,
			scope,
		);
		set.headers["X-Request-Id"] = operation.requestId;
		return { operation };
	});
