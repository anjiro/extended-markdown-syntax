import { SyntaxNode } from "@lezer/common";
import { InlineFormat } from "src/types";

export const EditorDelimLookup: Record<string, InlineFormat> = {}

export const ShifterNodeConfigs: Record<string, { query: string, getOpen: (node: SyntaxNode) => SyntaxNode | null }> = {
	["table-row"]: {
		query: "table-row",
		getOpen(node) {
			while (!node.name.includes("table-row-0")) {
				node = node.prevSibling!;
			}
			return node;
		}
	},
	["url"]: {
		query: "url",
		getOpen(node) {
			return node;
		}
	},
	["math"]: {
		query: "math",
		getOpen(node) {
			while (!node.name.includes("math-begin")) {
				let prevSibling = node.prevSibling ?? node.parent?.prevSibling?.lastChild ?? null;
				if (!prevSibling) { return null }
				node = prevSibling;
			}
			if (node.to - node.from != 1) { return null }
			else { return node }
		}
	},
	["link"]: {
		query: "link(?<=internal-link)|link(?=-start|end)",
		getOpen(node) {
			while (!node.name.includes("link-start")) {
				node = node.prevSibling!;
			}
			return node;
		}
	},
	["formatting-list"]: {
		query: "formatting-list",
		getOpen(node) {
			return node.parent;
		}
	},
	["hr"]: {
		query: "hr",
		getOpen(node) {
			return node;
		},
	},
	["codeblock-begin"]: {
		query: "codeblock-begin",
		getOpen(node) {
			return node;
		},
	},
	["formatting-header"]: {
		query: "formatting-header",
		getOpen(node) {
			node = node.parent!;
			if (node.name.includes("header-line")) {
				node = node.prevSibling!;
			}
			return node;
		},
	},
	["formatting-quote"]: {
		query: "formatting-quote",
		getOpen(node) {
			return node.parent;
		}
	},
	["hmd-footnote"]: {
		query: "hmd-footnote",
		getOpen(node) {
			return node.parent;
		}
	}
}

export const SEMANTIC_INTERFERER_RE = /(?:codeblock|html|math)-(?:begin|end)|comment-(?:start|end)|cdata|tag$/;
export const SKIPPED_NODE_RE = /table|code|formatting|escape|html|math|tag|url|barelink|atom|comment|string|meta|frontmatter|internal-link|hr(?!\w)/;
export const COLOR_TAG_RE = /[a-z0-9-]+:/iy;
export const SHIFTER_RE = (() => {
	let queries = "";
	for (let el in ShifterNodeConfigs) {
		queries += (queries ? "|" : "") + ShifterNodeConfigs[el as keyof typeof ShifterNodeConfigs].query;
	}
	return new RegExp(queries);
})();