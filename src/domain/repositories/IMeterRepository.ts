import type { LicenseMeter, UsageLedgerEntry } from "../entities";

export type UsageConsumptionResult =
	| {
			status: "consumed" | "replayed";
			meter: LicenseMeter;
			entry: UsageLedgerEntry;
	  }
	| { status: "conflict" }
	| { status: "not-found" }
	| { status: "archived" }
	| { status: "exhausted" };

export type MeterAdjustmentResult =
	| { status: "adjusted"; meter: LicenseMeter; entry: UsageLedgerEntry }
	| { status: "not-found" }
	| { status: "archived" }
	| { status: "out-of-range" };

export interface IMeterRepository {
	listMeters(
		licenseId: string,
		includeArchived?: boolean,
	): Promise<LicenseMeter[]>;
	createMeter(
		licenseId: string,
		name: string,
		balance: number,
		reason: string,
	): Promise<LicenseMeter>;
	archiveMeter(
		licenseId: string,
		name: string,
		reason: string,
	): Promise<LicenseMeter | null>;
	consume(
		licenseId: string,
		meterName: string,
		units: number,
		eventId: string,
	): Promise<UsageConsumptionResult>;
	adjust(
		licenseId: string,
		meterName: string,
		delta: number,
		reason: string,
		kind: "top_up" | "adjustment",
	): Promise<MeterAdjustmentResult>;
	listLedger(
		licenseId: string,
		meterName?: string,
	): Promise<UsageLedgerEntry[]>;
}
