export type $AdminOptions<T> = {
	topology?: "read" | "write";
	secretIds?: (result: T) => string[];
};
