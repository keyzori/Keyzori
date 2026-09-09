function omitLicenseSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(omitLicenseSecrets);
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "licenseKey")
			.map(([key, entry]) => [key, omitLicenseSecrets(entry)]),
	);
}

export function printJson(value: unknown, revealLicenseKey = false): void {
	console.log(
		JSON.stringify(
			revealLicenseKey ? value : omitLicenseSecrets(value),
			null,
			2,
		),
	);
}
