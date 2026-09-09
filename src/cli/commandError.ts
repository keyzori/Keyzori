const SECRET_PATTERN = /\b(?:lic|sk)_[A-Za-z0-9_-]+\b/g;
const DATABASE_URL_PATTERN = /\b(?:postgres(?:ql)?):\/\/[^\s]+/gi;

function safeMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(SECRET_PATTERN, "[REDACTED_LICENSE_KEY]")
		.replace(DATABASE_URL_PATTERN, "[REDACTED_DATABASE_URL]");
}

export function reportCommandError(action: string, error: unknown): void {
	console.error(`${action}: ${safeMessage(error)}`);
	process.exitCode = 1;
}

export async function runCommand(
	action: string,
	handler: () => Promise<void>,
): Promise<void> {
	try {
		await handler();
	} catch (error) {
		reportCommandError(action, error);
	}
}
