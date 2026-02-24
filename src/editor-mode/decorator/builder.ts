import { ChangeDesc, ChangeSet, EditorState, Range, RangeSet, RangeValue, Text, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { DisplayBehaviour, Format, MarkdownViewMode, TokenLevel, TokenStatus } from "src/enums";
import { BlockFormat, PlainRange, InlineFormat, TokenGroup, TokenDecoration, PluginSettings, Token } from "src/types";
import { BlockRules, InlineRules } from "src/format-configs/rules";
import { trimTag } from "src/format-configs/format-utils";
import { EditorParser } from "src/editor-mode/preprocessor/parser";
import { SelectionObserver } from "src/editor-mode/preprocessor/observer";
import { ActivityRecord } from "src/editor-mode/cm-extensions";
import { LineBreak, HiddenWidget, ColorButton } from "src/editor-mode/decorator/widgets";
import { REVEALED_SPOILER_DECO } from "src/editor-mode/decorator/decorations";
import { getTagRange, iterTokenGroup, provideTokenPartsRanges } from "src/editor-mode/utils/token-utils"
import { TextCursor } from "src/editor-mode/utils/doc-utils";

interface RangeSetUpdate<T extends RangeValue> {
	add?: readonly Range<T>[];
	sort?: boolean;
	filter?: (from: number, to: number, value: T) => boolean;
	filterFrom?: number;
	filterTo?: number;
}

function _createInlineDecoRange(token: Token, cls: string) {
	return (Decoration
		.mark({ class: cls, token }) as TokenDecoration)
		.range(token.from, token.to);
}

class _DecorationHolder {
	public inlineSet: DecorationSet = RangeSet.empty;
	public blockSet: DecorationSet = RangeSet.empty;
	public inlineOmittedSet: DecorationSet = RangeSet.empty;
	public blockOmittedSet: DecorationSet = RangeSet.empty;
	public colorBtnSet: DecorationSet = RangeSet.empty;
	public revealedSpoilerSet: DecorationSet = RangeSet.empty;
	public lineBreaksSet: DecorationSet = RangeSet.empty;
}

class _DelimOmitter {
	private readonly _selectionObserver: SelectionObserver;
	private readonly _settings: PluginSettings;

	constructor(settings: PluginSettings, selectionObserver: SelectionObserver) {
		this._settings = settings;
		this._selectionObserver = selectionObserver;
	}

	public omitBlock(omittedSet?: DecorationSet, changes?: ChangeDesc): DecorationSet {
		let omittedRanges: Range<Decoration>[] = [],
			filterRegion = this._selectionObserver.filterRegions[TokenLevel.BLOCK];

		this._selectionObserver.iterateChangedRegion(TokenLevel.BLOCK, (token, _, __, inSelection) => {
			if (inSelection || token.status != TokenStatus.ACTIVE || !token.validTag) return;
			let openFrom = token.from,
				openTo = openFrom + token.openLen + token.tagLen;
			if (token.to > openTo) openTo++;
			omittedRanges.push(HiddenWidget.of(openFrom, openTo, token, true));
		});

		if (!omittedSet?.size) {
			omittedSet = Decoration.set(omittedRanges);
		} else {
			if (changes)
				omittedSet = omittedSet.map(changes);
			
			for (let i = 0; i < filterRegion.length; i++) {
				let filterRange = filterRegion[i];
				omittedSet = omittedSet.update({
					filterFrom: filterRange.from,
					filterTo: filterRange.to,
					filter: () => false,
				});
			}
			omittedSet = omittedSet.update({ add: omittedRanges });
		}

		return omittedSet;
	}

	public omitInline(activeTokens: TokenGroup): DecorationSet {
		let alwaysShowHlTag = this._settings.hlTagDisplayBehaviour & DisplayBehaviour.ALWAYS,
			alwaysShowSpanTag = this._settings.spanTagDisplayBehaviour & DisplayBehaviour.ALWAYS,
			showHlTagIfTouched = this._settings.hlTagDisplayBehaviour & DisplayBehaviour.TAG_TOUCHED,
			showSpanTagIfTouched = this._settings.spanTagDisplayBehaviour & DisplayBehaviour.TAG_TOUCHED;

		let omittedRanges: Range<Decoration>[] = [];

		for (let i = 0; i < activeTokens.length; i++) {
			let token = activeTokens[i],
				openFrom = token.from,
				openTo = openFrom + token.openLen,
				tagTo = openTo + token.tagLen;
			if (this._selectionObserver.touchSelection(token.from, token.to)) {
				if (
					token.validTag && !this._selectionObserver.touchSelection(openTo, tagTo) &&
					(token.type == Format.HIGHLIGHT && showHlTagIfTouched || token.type == Format.CUSTOM_SPAN && showSpanTagIfTouched)                    
				) {
					omittedRanges.push(HiddenWidget.of(openTo, tagTo, token));
				}
			} else {
				if (token.type == Format.HIGHLIGHT && !alwaysShowHlTag || token.type == Format.CUSTOM_SPAN && !alwaysShowSpanTag) {
					openTo = tagTo;
				}
				omittedRanges.push(HiddenWidget.of(openFrom, openTo, token));
				if (token.closeLen) {
					omittedRanges.push(HiddenWidget.of(token.to - token.closeLen, token.to, token));
				}
			}
		}

		return Decoration.set(omittedRanges, true);
	}
}

class _LineBreakReplacer {
	public readonly parser: EditorParser;
	public lineBreakSet: RangeSet<Decoration> = RangeSet.empty;

	constructor(parser: EditorParser) {
		this.parser = parser;
	}

	public replace(doc: Text, changes?: ChangeSet): DecorationSet {
		let reparsedRange = this.parser.reparsedRanges[TokenLevel.BLOCK],
			blockTokens = this.parser.blockTokens,
			updateSpec: RangeSetUpdate<Decoration> = {
				add: this._produceWidgetRanges(doc)
			};
		
		if (!blockTokens.length)
			return this.lineBreakSet = RangeSet.empty;

		if (reparsedRange.from != reparsedRange.initTo || reparsedRange.from != reparsedRange.changedTo) {
			updateSpec.filterFrom = Math.min(blockTokens[reparsedRange.from]?.from ?? this.parser.lastStreamPoint.from, this.parser.lastStreamPoint.from);
			updateSpec.filterTo = this.parser.lastStreamPoint.to;
			updateSpec.filter = () => false;
		}

		if (changes) this.lineBreakSet = this.lineBreakSet.map(changes);
		return this.lineBreakSet = this.lineBreakSet.update(updateSpec);
	}

	private _getReparsedBlockTokens(): TokenGroup {
		let range = this.parser.reparsedRanges[TokenLevel.BLOCK];
		return this.parser.blockTokens.slice(range.from, range.changedTo);
	}

	private _produceWidgetRanges(doc: Text): Range<Decoration>[] {
		let tokens = this._getReparsedBlockTokens(),
			ranges: Range<Decoration>[] = [];
		if (!tokens.length) { return ranges }

		let tokenIndex = 0,
			textCursor = TextCursor.atOffset(doc, tokens[0].from);

		do {
			let curToken = tokens[tokenIndex],
				{ curLine } = textCursor;
			if (!curToken) break;
			if (curToken.status != TokenStatus.ACTIVE) { tokenIndex++; continue }
			if (
				curLine.from == curToken.from ||
				curLine.from - 1 == curToken.from + curToken.openLen + curToken.tagLen
			) continue;
			if (
				curLine.from >= curToken.to ||
				curLine.to < curToken.from ||
				curLine.to == curToken.to && curToken.closedByBlankLine
			) { tokenIndex++; continue }
			ranges.push(LineBreak.of(curLine.from));
		} while (textCursor.next());

		return ranges;
	}
}

class _TokensBuffer {
	public activeTokens: TokenGroup = [];
	public hlTokens: TokenGroup = [];
	public spoilerTokens: TokenGroup = [];

	public catch(activeTokens: TokenGroup, hlTokens: TokenGroup, spoilerTokens: TokenGroup): void {
		this.activeTokens = activeTokens;
		this.hlTokens = hlTokens;
		this.spoilerTokens = spoilerTokens;
	}

	public empty(): void {
		this.activeTokens = [];
		this.hlTokens = [];
		this.spoilerTokens = [];
	}
}

export class DecorationBuilder {
	private readonly _parser: EditorParser;
	private readonly _omitter: _DelimOmitter;
	private readonly _catcher: _TokensBuffer;
	private readonly _lineBreakReplacer: _LineBreakReplacer;
	private readonly _selectionObserver: SelectionObserver;
	private readonly _settings: PluginSettings;

	public readonly holder: _DecorationHolder;

	constructor(parser: EditorParser, selectionObserver: SelectionObserver) {
		this._parser = parser;
		this._selectionObserver = selectionObserver;
		this._settings = parser.settings;
		this._omitter = new _DelimOmitter(this._settings, selectionObserver);
		this._catcher = new _TokensBuffer();
		this._lineBreakReplacer = new _LineBreakReplacer(parser);
		this.holder = new _DecorationHolder();
	}

	/**
	 * Main decorations hold basic formatting style of the tokens.
	 * 
	 * Intended to build non-height-altering decorations. So, it doesn't
	 * include line breaks and fenced div opening omitter. (It runs only in
	 * the view update)
	 */
	public buildMain(view: EditorView, state: EditorState, noStyledFencedDiv: boolean): void {
		let { visibleRanges } = view,
			visibleText = state.sliceDoc(
				visibleRanges[0]?.from ?? 0,
				visibleRanges[visibleRanges.length - 1]?.to ?? 0
			);
		if (!visibleRanges.length) visibleRanges = [{ from: 0, to: 0 }];
		this._buildInline(visibleRanges, visibleText);
		this._buildBlock(visibleRanges, visibleText, noStyledFencedDiv);
	}

	/**
	 * Supplementary decorations consist omitted delimiter of inline tokens,
	 * color buttons for the highlight, and revealed spoiler when touched the
	 * cursor or selection.
	 * 
	 * Intended to build non-height-altering decorations. So, it doesn't
	 * include line breaks and fenced div opening omitter. (It runs only in
	 * the view update)
	 */
	public buildSupplementary(isLivePreview: boolean): void {
		if (isLivePreview) {
			this._omitInlineDelim(this._catcher.activeTokens);
			this._createColorBtnWidgets(this._catcher.hlTokens);
			this._revealSpoiler(this._catcher.spoilerTokens);
		} else {
			this.holder.colorBtnSet = this.holder.revealedSpoilerSet = RangeSet.empty;
		}
	}

	/**
	 * Runs once on editor intialization, should be inside the view update
	 * (i.e. the ViewPlugin update).
	 */
	public onViewInit(view: EditorView): void {
		let state = view.state,
			isLivePreview = state.field(editorLivePreviewField),
			noStyledFencedDiv = !isLivePreview && this._settings.noStyledDivInSourceMode;
		this.buildMain(view, state, noStyledFencedDiv);
		this.buildSupplementary(isLivePreview);
	}

	public onViewUpdate(update: ViewUpdate, activities: ActivityRecord): void {
		let state = update.state,
			view = update.view,
			isLivePreview = state.field(editorLivePreviewField),
			noStyledFencedDiv = !isLivePreview && this._settings.noStyledDivInSourceMode;

		if (activities.isParsing || activities.isRefreshed || (activities.isModeChanged && this._settings.noStyledDivInSourceMode) || update.viewportMoved) {
			this.buildMain(view, state, noStyledFencedDiv);
		}

		if (activities.isObserving || activities.isRefreshed || update.viewportMoved) {
			this.buildSupplementary(isLivePreview);
		}

		activities.isParsing =
		activities.isObserving =
		activities.isRefreshed =
		activities.isModeChanged = false;
	}

	/**
	 * Runs once on editor intialization, should be inside the state update
	 * (i.e. the StateField update).
	 */
	public onStateInit(state: EditorState): void {
		let isLivePreview = state.field(editorLivePreviewField);
		if (isLivePreview) {
			this._omitFencedDivOpening();
		}
		this._replaceLineBreaks(state.doc);
	}

	public onStateUpdate(transaction: Transaction, activities: ActivityRecord): void {
		if (activities.isParsing)
			this._replaceLineBreaks(transaction.newDoc, transaction.changes);

		if (activities.isModeChanged || activities.isDeepRefreshed)
			this.holder.blockOmittedSet = RangeSet.empty;

		if (!transaction.state.field(editorLivePreviewField)) {
			this._removeOmitter();
		} else if (activities.isObserving || activities.isModeChanged) {
			this._omitFencedDivOpening(transaction.changes);
		}
	}

	private _buildInline(visibleRanges: readonly PlainRange[], visibleText: string): DecorationSet {
		let inlineDecoRanges: Range<TokenDecoration>[] = [],
			activeTokens: TokenGroup = [],
			hlTokens: TokenGroup = [],
			spoilerTokens: TokenGroup = [],
			viewportStart = visibleRanges[0].from;

		iterTokenGroup({
			tokens: this._parser.inlineTokens,
			ranges: visibleRanges,
			callback: token => {
				if (token.status != TokenStatus.ACTIVE) return;
				if (token.type == Format.HIGHLIGHT) hlTokens.push(token);
				if (token.type == Format.SPOILER) spoilerTokens.push(token);
				activeTokens.push(token);
				let cls = "cm-" + InlineRules[token.type as InlineFormat].class;
				if (token.tagLen) {
					let tagRange = getTagRange(token),
						// HIGHLIGHT tag is "Color:" (skip trailing colon only); CUSTOM_SPAN tag is "{cls}" (skip braces)
						tagStart = token.type == Format.HIGHLIGHT ? tagRange.from - viewportStart : tagRange.from - viewportStart + 1,
						tagStr = visibleText.slice(tagStart, tagRange.to - viewportStart - 1);
					if (token.type == Format.CUSTOM_SPAN) {
						tagStr = trimTag(tagStr);
						cls += " " + tagStr;
					} else {
						cls += " " + cls + "-" + tagStr;
					}
				}
				inlineDecoRanges.push(_createInlineDecoRange(token, cls));
			},
		});

		this._catcher.catch(activeTokens, hlTokens, spoilerTokens);
		return this.holder.inlineSet = Decoration.set(inlineDecoRanges);
	}

	private _buildBlock(visibleRanges: readonly PlainRange[], visibleText: string, noStyle: boolean): DecorationSet {
		let lineDecoRanges: Range<TokenDecoration>[] = [],
			viewportStart = visibleRanges[0].from;

		iterTokenGroup({
			tokens: this._parser.blockTokens,
			ranges: visibleRanges,
			callback: token => {
				if (token.status != TokenStatus.ACTIVE) return;
	
				let baseCls = "cm-" + BlockRules[token.type as BlockFormat].class,
					{ contentRange, tagRange } = provideTokenPartsRanges(token),
					tagStr = trimTag(visibleText.slice(tagRange.from - viewportStart, tagRange.to - viewportStart)),
					openDelimCls = baseCls + " cm-fenced-div-start",
					contentCls = baseCls + (noStyle ? "" : " " + tagStr),
					hasContent = !!visibleText
						.slice(contentRange.from - viewportStart, contentRange.to - viewportStart)
						.trimEnd();

				lineDecoRanges.push(
					(Decoration.line({ class: openDelimCls, token }) as TokenDecoration)
						.range(token.from)
				);

				if (hasContent) {
					lineDecoRanges.push(
						(Decoration.line({ class: contentCls, token }) as TokenDecoration)
							.range(contentRange.from + 1)
					);
				}
			}
		});

		return this.holder.blockSet = Decoration.set(lineDecoRanges);
	}

	private _createColorBtnWidgets(hlTokens: TokenGroup): DecorationSet {
		if (!this._settings.colorButton)
			return this.holder.colorBtnSet = RangeSet.empty;

		let btnWidgets: Range<Decoration>[] = [];
		for (let i = 0; i < hlTokens.length; i++) {
			let token = hlTokens[i];
			if (this._selectionObserver.touchSelection(token.from, token.to)) {
				btnWidgets.push(ColorButton.of(token));
			}
		}
		return this.holder.colorBtnSet = Decoration.set(btnWidgets);
	}

	private _revealSpoiler(spoilerTokens: TokenGroup): DecorationSet {
		let revealedRanges: Range<Decoration>[] = [];
		for (let i = 0; i < spoilerTokens.length; i++) {
			let token = spoilerTokens[i];
			if (this._selectionObserver.touchSelection(token.from, token.to)) {
				revealedRanges.push(REVEALED_SPOILER_DECO.range(token.from, token.to));
			}
		}
		return this.holder.revealedSpoilerSet = Decoration.set(revealedRanges);
	}

	private _omitInlineDelim(activeTokens: TokenGroup): DecorationSet {
		return this.holder.inlineOmittedSet = this._omitter.omitInline(activeTokens);
	}

	/** Executed only in the state update. */
	private _replaceLineBreaks(doc: Text, changes?: ChangeSet): DecorationSet {
		return this.holder.lineBreaksSet = this._lineBreakReplacer.replace(doc, changes);
	}

	/** Executed only in the state update. */
	private _omitFencedDivOpening(changes?: ChangeDesc): DecorationSet {
		let isOmitted = !(this._settings.alwaysShowFencedDivTag & MarkdownViewMode.EDITOR_MODE);
		if (!isOmitted) {
			return this.holder.blockOmittedSet = RangeSet.empty;
		}
		return this.holder.blockOmittedSet = this._omitter.omitBlock(this.holder.blockOmittedSet, changes);
	}

	private _removeOmitter(): void {
		this.holder.inlineOmittedSet = this.holder.blockOmittedSet = RangeSet.empty;
	}
}