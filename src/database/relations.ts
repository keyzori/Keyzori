import { defineRelations } from "drizzle-orm";
import { customers } from "../customers/tables.ts";
import { licenses, subscriptions, trials } from "../licenses/tables.ts";
import {
	licenseBlocks,
	devices,
	ips,
	deviceAllowlist,
	ipAllowlist,
} from "../access/tables.ts";
import { meters, usageLedger } from "../meters/tables.ts";
import { activity } from "../activity/tables.ts";

export const relations = defineRelations(
	{
		customers,
		licenses,
		subscriptions,
		trials,
		licenseBlocks,
		devices,
		ips,
		deviceAllowlist,
		ipAllowlist,
		meters,
		usageLedger,
		activity,
	},
	(r) => ({
		customers: {
			licenses: r.many.licenses({
				from: r.customers.id,
				to: r.licenses.customerId,
			}),
		},
		licenses: {
			customer: r.one.customers({
				from: r.licenses.customerId,
				to: r.customers.id,
				optional: false,
			}),
			subscription: r.one.subscriptions({
				from: r.licenses.id,
				to: r.subscriptions.licenseId,
			}),
			trial: r.one.trials({ from: r.licenses.id, to: r.trials.licenseId }),
			blocks: r.many.licenseBlocks({
				from: r.licenses.id,
				to: r.licenseBlocks.licenseId,
			}),
		},
	}),
);
