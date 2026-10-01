export class Replay extends Error {
	constructor(readonly result: Record<string, unknown>) {
		super("Completed operation replay");
	}
}
