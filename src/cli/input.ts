export async function jsonInput(
	input: string,
): Promise<Record<string, unknown>> {
	const value: unknown = input.startsWith("@")
		? await Bun.file(input.slice(1)).json()
		: JSON.parse(input);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected a JSON object or @file.json.");
	return value as Record<string, unknown>;
}
export type Output = (value: unknown) => void;
export const print: Output = (value) =>
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
export const segment = (value: string) => encodeURIComponent(value);
