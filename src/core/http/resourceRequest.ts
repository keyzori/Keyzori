import { HttpError } from "./HttpError";

/** Collections have one shape. Individual resources use the path parameter. */
export function collectionQuery(request: Request) {
	const query = new URL(request.url).searchParams;
	if (query.has("id"))
		throw new HttpError("INVALID_REQUEST", {
			id: "Use the resource detail path",
		});
	return query;
}

export function detailQuery(request: Request, id: string) {
	if (new URL(request.url).search) throw new HttpError("INVALID_REQUEST");
	return new URLSearchParams({ id });
}
