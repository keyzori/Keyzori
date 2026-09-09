import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	activityEvents,
	activityMinuteBuckets,
	activityTotals,
	customers,
	licenseDeviceAllowlistEntries,
	licenseIpAllowlistEntries,
	licenseMeters,
	licenses,
	licenseType,
	registeredDevices,
	stripeSubscriptionLinks,
	stripeWebhookEvents,
	usageLedgerEntries,
} from "../db/schema";

describe("database schema", () => {
	test("uses canonical lowercase license types and plural snake-case tables", () => {
		expect(licenseType.enumValues).toEqual([
			"lifetime",
			"subscription",
			"metered",
			"trial",
		]);
		expect(
			[
				customers,
				licenses,
				licenseIpAllowlistEntries,
				licenseDeviceAllowlistEntries,
				registeredDevices,
				licenseMeters,
				usageLedgerEntries,
				activityEvents,
				activityTotals,
				activityMinuteBuckets,
				stripeSubscriptionLinks,
				stripeWebhookEvents,
			].map((table) => getTableConfig(table).name),
		).toEqual([
			"customers",
			"licenses",
			"license_ip_allowlist_entries",
			"license_device_allowlist_entries",
			"registered_devices",
			"license_meters",
			"usage_ledger_entries",
			"activity_events",
			"activity_totals",
			"activity_minute_buckets",
			"stripe_subscription_links",
			"stripe_webhook_events",
		]);
	});

	test("enforces license, meter, usage, access, and Stripe uniqueness", () => {
		expect(getTableConfig(licenses).checks.map((item) => item.name)).toEqual([
			"licenses_max_ips_nonnegative",
			"licenses_max_devices_nonnegative",
			"licenses_max_sessions_nonnegative",
			"licenses_session_revision_nonnegative",
			"licenses_trial_duration_nonnegative",
			"licenses_subscription_expiry_required",
			"licenses_trial_duration_required",
		]);
		expect(
			getTableConfig(licenseMeters).indexes.map((item) => item.config.name),
		).toContain("license_meters_license_name_unique");
		expect(
			getTableConfig(usageLedgerEntries).indexes.map(
				(item) => item.config.name,
			),
		).toContain("usage_ledger_license_event_unique");
		expect(
			getTableConfig(stripeSubscriptionLinks).indexes.map(
				(item) => item.config.name,
			),
		).toEqual([
			"stripe_subscription_links_license_unique",
			"stripe_subscription_links_subscription_unique",
		]);
		expect(
			getTableConfig(stripeSubscriptionLinks).columns.map(
				(column) => column.name,
			),
		).toContain("stripe_customer_id");
	});
});
