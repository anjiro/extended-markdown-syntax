import { InlineFormat } from "src/types";

export const COLOR_TAG_RE = /^([a-z0-9-]+):/i;
export const CUSTOM_SPAN_TAG_RE = /^\{([a-z0-9 -]+)\}/i;
export const FENCED_DIV_RE = /:{3,}(?=([a-z0-9 -]+))\1$/yi;

export const PreviewDelimLookup: Record<string, InlineFormat> = {}

export const SKIPPED_CLASSES = [
	"internal-link",
	"external-link",
	"math",
	"internal-embed",
	"list-bullet",
	"collapse-indicator"
];