import { Format, MarkdownViewMode } from "src/enums";
import { PluginSettings, InlineFormat } from "src/types";
import { InlineRules } from "src/format-configs/rules";
import { EditorDelimLookup } from "src/editor-mode/preprocessor/parser-configs";
import { PreviewDelimLookup } from "src/preview-mode/post-processor/configs";

export function configureDelimLookup(settings: PluginSettings): void {
	for (let key in EditorDelimLookup) {
		delete EditorDelimLookup[key];
	}
	for (let key in PreviewDelimLookup) {
		delete PreviewDelimLookup[key];
	}

	// editor
	if (settings.insertion & MarkdownViewMode.EDITOR_MODE) {
		EditorDelimLookup[InlineRules[Format.INSERTION].char] = Format.INSERTION;
	}
	if (settings.spoiler & MarkdownViewMode.EDITOR_MODE) {
		EditorDelimLookup[InlineRules[Format.SPOILER].char] = Format.SPOILER;
	}
	if (settings.superscript & MarkdownViewMode.EDITOR_MODE) {
		EditorDelimLookup[InlineRules[Format.SUPERSCRIPT].char] = Format.SUPERSCRIPT;
	}
	if (settings.subscript & MarkdownViewMode.EDITOR_MODE) {
		EditorDelimLookup[InlineRules[Format.SUBSCRIPT].char] = Format.SUBSCRIPT;
	}
	if (settings.customHighlight & MarkdownViewMode.EDITOR_MODE) {
		EditorDelimLookup[InlineRules[Format.HIGHLIGHT].char] = Format.HIGHLIGHT;
	}
	if (settings.customSpan & MarkdownViewMode.EDITOR_MODE) {
		EditorDelimLookup[InlineRules[Format.CUSTOM_SPAN].char] = Format.CUSTOM_SPAN;
	}
	// preview
	if (settings.insertion & MarkdownViewMode.PREVIEW_MODE) {
		PreviewDelimLookup[InlineRules[Format.INSERTION].char] = Format.INSERTION;
	}
	if (settings.spoiler & MarkdownViewMode.PREVIEW_MODE) {
		PreviewDelimLookup[InlineRules[Format.SPOILER].char] = Format.SPOILER;
	}
	if (settings.superscript & MarkdownViewMode.PREVIEW_MODE) {
		PreviewDelimLookup[InlineRules[Format.SUPERSCRIPT].char] = Format.SUPERSCRIPT;
	}
	if (settings.subscript & MarkdownViewMode.PREVIEW_MODE) {
		PreviewDelimLookup[InlineRules[Format.SUBSCRIPT].char] = Format.SUBSCRIPT;
	}
	if (settings.customHighlight & MarkdownViewMode.PREVIEW_MODE) {
		PreviewDelimLookup[InlineRules[Format.HIGHLIGHT].char] = Format.HIGHLIGHT;
	}
	if (settings.customSpan & MarkdownViewMode.PREVIEW_MODE) {
		PreviewDelimLookup[InlineRules[Format.CUSTOM_SPAN].char] = Format.CUSTOM_SPAN;
	}
}

export function isInlineFormat(type: Format): type is InlineFormat {
	return type >= Format.INSERTION && type <= Format.CUSTOM_SPAN
}

export function supportTag(type: Format): type is Format.HIGHLIGHT | Format.CUSTOM_SPAN | Format.FENCED_DIV {
	return type >= Format.HIGHLIGHT || type == Format.FENCED_DIV;
}

export function trimTag(tagStr: string): string {
	return tagStr
		.trim()
		.replaceAll(/\s{2,}/g, " ");
}