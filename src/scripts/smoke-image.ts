import { command } from "./command";

/** CI supplies the local ID from its one build; standalone smoke builds the current checkout. */
export async function smokeImage(signal: AbortSignal) {
	const supplied = Bun.env.KZ_SMOKE_IMAGE_ID;
	if (supplied !== undefined && !/^sha256:[a-f0-9]{64}$/.test(supplied))
		throw new Error("KZ_SMOKE_IMAGE_ID must be an immutable local image ID");
	const id =
		supplied ??
		(
			await command(
				[
					"docker",
					"build",
					"--load",
					"--quiet",
					"--provenance=false",
					"--sbom=false",
					"-f",
					"src/Dockerfile",
					".",
				],
				{ signal, timeoutMs: 300000 },
			)
		).output;
	if (
		!/^sha256:[a-f0-9]{64}$/.test(id) ||
		(
			await command(["docker", "image", "inspect", "--format", "{{.Id}}", id], {
				signal,
			})
		).output !== id
	)
		throw new Error("The exact locally built smoke image is unavailable");
	return id;
}
