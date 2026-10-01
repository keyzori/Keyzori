import { t } from "elysia";
import type { $Metadata } from "../../types/metadata";

const metadataObject = t.Record(
	t.String({ pattern: "^[\\s\\S]*$" }),
	t.Ref("MetadataValue"),
	{
		maxProperties: 64,
		propertyNames: t.String({
			minLength: 1,
			maxLength: 128,
			pattern: "^(?!(?:__proto__|constructor|prototype)(?![\\s\\S]))",
		}),
	},
);

export const metadataDefinitions = {
	MetadataValue: t.Union([
		t.String({ maxLength: 8192 }),
		t.Number(),
		t.Boolean(),
		t.Null(),
		t.Array(t.Ref("MetadataValue"), { maxItems: 256 }),
		metadataObject,
	]),
	Metadata: metadataObject,
};

export const httpModel = {
	id: t.String({ format: "uuid" }),
	name: t.String({ minLength: 1, maxLength: 256 }),
	notes: t.Union([t.String({ maxLength: 16384 }), t.Null()]),
	reason: t.String({ minLength: 1, maxLength: 4096 }),
	metadata: t.Unsafe<$Metadata>(
		t.Cyclic(metadataDefinitions, "Metadata", {
			description:
				"JSON object with nested objects, arrays, strings, finite numbers, booleans and null. Maximum depth 16 from root depth 0, 4096 total values, 64 properties per object, 256 entries per array, 1–128 characters per key, 8192 UTF-8 bytes per string and 1048576 serialized UTF-8 bytes. Prototype keys are forbidden at every depth. Keys and strings must contain well-formed Unicode without NUL for JSONB storage. Only top-level string and number values support metadata filters.",
		}),
	),
	expiresAt: t.Union([t.String({ format: "date-time" }), t.Null()]),
	ids: t.Array(t.String({ format: "uuid" }), {
		minItems: 1,
		uniqueItems: true,
	}),
	error: t.Object(
		{
			code: t.String(),
			reason: t.String(),
			errors: t.Optional(t.Record(t.String(), t.String())),
			ids: t.Optional(t.Array(t.String({ format: "uuid" }))),
		},
		{ additionalProperties: false },
	),
};
