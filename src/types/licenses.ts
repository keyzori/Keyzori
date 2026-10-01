import type { UnwrapSchema } from "elysia";
import type { licenseModel } from "../plugins/licenses/model";
import type { licenses } from "../core/database/schema/licenses";

export type $License = typeof licenses.$inferSelect;
export type $LicenseAdmin = UnwrapSchema<typeof licenseModel.issued>["data"];
export type $LicenseCreate = UnwrapSchema<typeof licenseModel.create>;
export type $LicenseUpdate = UnwrapSchema<typeof licenseModel.update>;
export type $LicenseAction = UnwrapSchema<typeof licenseModel.action>;
export type $LicenseRotate = UnwrapSchema<typeof licenseModel.rotate>;
export type $LicenseDelete = UnwrapSchema<typeof licenseModel.delete>;
export type $MeterAdjustment = UnwrapSchema<typeof licenseModel.adjust>;
export type $HardwareRemoval = UnwrapSchema<typeof licenseModel.removeHardware>;
export type $IpRemoval = UnwrapSchema<typeof licenseModel.removeIps>;
