export type $MetadataValue =
	| string
	| number
	| boolean
	| null
	| $Metadata
	| $MetadataValue[];

export type $Metadata = { [key: string]: $MetadataValue };
