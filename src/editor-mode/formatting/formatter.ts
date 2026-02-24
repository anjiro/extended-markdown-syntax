import { ChangeSet, ChangeSpec, EditorSelection, EditorState, SelectionRange, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Format, TokenLevel, TokenStatus } from "src/enums";
import { BlockFormat, InlineFormat, PluginSettings, TokenGroup, PlainRange, Token } from "src/types";
import { SelectionObserver } from "src/editor-mode/preprocessor/observer";
import { EditorParser } from "src/editor-mode/preprocessor/parser";
import { getTagRange, provideTokenPartsRanges } from "src/editor-mode/utils/token-utils";
import { getBlocks, isBlockStart, isBlockEnd } from "src/editor-mode/utils/doc-utils";
import { trimSelection } from "src/editor-mode/utils/selection-utils";
import { isTouched } from "src/editor-mode/utils/range-utils";
import { TagMenu } from "src/editor-mode/ui-components";
import { BlockRules, InlineRules } from "src/format-configs/rules";
import { isInlineFormat, supportTag } from "src/format-configs/format-utils";

function _isSurroundedByDelimiter(str: string, delimStr: string): boolean {
	return str.startsWith(delimStr) && str.endsWith(delimStr);
}

class _FormatterState {
	public editorState: EditorState;
	public doc: Text;
	public tokens: TokenGroup;
	public selectionRanges: SelectionRange[];
	public curSelectionIndex: number = 0;
	public tokenMaps: (number[] | undefined)[];
	public curTokenMap: number[] | undefined;
	public level: TokenLevel;
	public type: Format;
	public delimStr: string;
	public closeDelimStr: string;
	public tagStr: string | undefined;
	public precise: boolean;
	public changes: ChangeSpec[] = [];
	public selectionShift: Partial<Record<number, { shift: number }>> = {};
	public changeSet: ChangeSet;
	public remappedSelection: EditorSelection;

	constructor(type: Format, editorState: EditorState, selectionObserver: SelectionObserver, settings: PluginSettings, tagStr?: string) {
		this.type = type;
		this.editorState = editorState;
		this.doc = editorState.doc;
		this.level = isInlineFormat(type) ? TokenLevel.INLINE : TokenLevel.BLOCK;
		this.tagStr = tagStr;
		this.precise = settings.tidyFormatting;
		this.tokens = selectionObserver.parser.getTokens(this.level);
		this.tokenMaps = selectionObserver.pickMaps(type);
		this.curTokenMap = this.tokenMaps[this.curSelectionIndex];
		if (this.precise) {
			let trimmedSelection = trimSelection(selectionObserver.selection, this.doc);
			this.selectionRanges = trimmedSelection.ranges.map(range => range);
		} else {
			this.selectionRanges = selectionObserver.selection.ranges.map(range => range);
		}
		let { char, length: delimLen } = this.level == TokenLevel.INLINE
			? InlineRules[type as InlineFormat]
			: BlockRules[type as BlockFormat];
		this.delimStr = char.padEnd(delimLen, char);
		this.closeDelimStr = this.delimStr;

		if (type == Format.HIGHLIGHT) {
			// Closing is always "::" regardless of whether there is a tag
			this.closeDelimStr = "::";
			if (tagStr) {
				// Opening: ":" + "Color:" = ":Color:", closing: "::"
				this.tagStr = tagStr + ":";
				this.delimStr = ":";
			} else {
				// No-color: opening and closing both "::"
				this.delimStr = "::";
			}
		} else if (tagStr && this.level == TokenLevel.INLINE) {
			this.tagStr = "{" + tagStr + "}";
		} else if (this.level == TokenLevel.BLOCK) {
			this.tagStr += "\n";
		}
	}

	public get curRange(): SelectionRange {
		return this.selectionRanges[this.curSelectionIndex];
	}

	public get mappedTokens(): TokenGroup {
		if (!this.curTokenMap) { return [] }
		return this.curTokenMap.map(index => this.tokens[index]);
	}

	public advance(): boolean {
		this.curSelectionIndex++
		if (this.curSelectionIndex >= this.selectionRanges.length) {
			return false;
		}
		this.curTokenMap = this.tokenMaps[this.curSelectionIndex];
		return true;
	}

	public pushChange(spec: ChangeSpec): void {
		this.changes.push(spec);
	}

	public pushSelectionShift(index: number, shift: number): void {
		this.selectionShift[index] = { shift };
	}
}

export class Formatter {
	private readonly _parser: EditorParser;
	private readonly _observer: SelectionObserver;
	private readonly _settings: PluginSettings;
	public state: _FormatterState;

	constructor(parser: EditorParser, observer: SelectionObserver) {
		this._parser = parser;
		this._observer = observer;
		this._settings = this._parser.settings;
	}

	public startFormat(view: EditorView, type: Format, tagStr?: string, forceRemove?: boolean, showMenu?: boolean): void {
		if (forceRemove) {
			tagStr = undefined;
		}
		if (!this._settings.openTagMenuAfterFormat) {
			showMenu = false;
		}

		let tokenMaps = this._observer.pickMaps(type),
			editorState = view.state;
		if (tokenMaps.length == 1 && !tokenMaps[0]?.length && showMenu) {
			TagMenu.create(view, type).showMenu();
			return;
		}
		this._defineState(editorState, type, tagStr);

		if (forceRemove) {
			this._removeAll()
		} else if (this.state.level == TokenLevel.INLINE) {
			this._formatInline();
		} else {
			this._formatBlock();
		}

		this._composeChanges();
		this._remapSelection();
		this._dispatchToView(view);
	}

	private _defineState(editorState: EditorState, type: Format, tagStr?: string): void {
		this.state = new _FormatterState(type, editorState, this._observer, this._settings, tagStr);
	}

	private _clearState(): void {
		(this.state as unknown as undefined) = undefined;
	}

	private _formatInline(): void {
		let state = this.state,
			tokens = this.state.tokens;

		do {
			let { curTokenMap, curRange, tagStr, precise } = state,
				firstToken = curTokenMap ? tokens[curTokenMap[0]] : null;
			if (!precise) {
				this._toggleInlineDelim();
			} else if (!firstToken) {
				this._wrap();
			} else if (firstToken.from > curRange.from || firstToken.to < curRange.to) {
				this._extend();
			} else if (firstToken.status != TokenStatus.ACTIVE) {
				this._close(firstToken);
			} else if (tagStr !== undefined) {
				this._changeInlineTag(firstToken);
			} else if (curRange.empty) {
				this._remove(firstToken);
			} else {
				this._breakApart(firstToken);
			}
		} while (state.advance());
	}

	private _formatBlock(): void {
		do {
			this._toggleBlockTag();
		} while (this.state.advance());
	}

	/**
	 * Use wrap only when the current range didn't meet any token.
	 * 
	 * **Exclusive to inline formatting use.**
	 */
	private _wrap(detectWord = true): void {
		let { curRange, delimStr, closeDelimStr, tagStr } = this.state;
		// If the current selection is actually an empty cursor, attempt to use
		// word range if any.
		if (curRange.empty) {
			let cursorOffset = curRange.from;
			if (detectWord) {
				curRange = this.state.editorState.wordAt(curRange.from) ?? curRange;
			}
			if (cursorOffset == curRange.to) {
				let shiftAmount = delimStr.length;
				if (cursorOffset == curRange.from) {
					shiftAmount += tagStr?.length ?? 0;
				}
				this.state.pushSelectionShift(this.state.curSelectionIndex, shiftAmount);
			}
		}
		this.state.pushChange([
			{ from: curRange.from, insert: delimStr + (tagStr ?? "") },
			{ from: curRange.to, insert: closeDelimStr }
		]);
	}

	/**
	 * Add corresponding closing delimiter to the token that's currently
	 * inactive. Should be run when the cursor is within or the same range as
	 * the token.
	 * 
	 * **Exclusive to inline formatting use.**
	 * 
	 * @param token should be in `INACTIVE` status.
	 */
	private _close(token: Token): void {
		let { closeDelimStr, tagStr } = this.state;
		if (supportTag(token.type) && tagStr) {
			this.state.pushChange({ from: token.from + token.openLen, insert: tagStr });
		}
		this.state.pushChange({ from: token.to, insert: closeDelimStr });
	}

	/**
	 * Break the current token into two new tokens if the current range
	 * was within the content range of the token and didn't touch both
	 * delimiters, or narrow it if one of both delimiters was touched, or
	 * behave like `remove()`. Should be run when the current selection
	 * range within the token.
	 * 
	 * **Exclusive to inline formatting use.**
	 */
	private _breakApart(token: Token): void {
		let { openRange, tagRange, closeRange } = provideTokenPartsRanges(token),
			{ curRange, delimStr, closeDelimStr } = this.state,
			tagStr = this.state.doc.sliceString(tagRange.from, tagRange.to);
		// Remove opening delimiter when the current range touched it. Otherwise,
		// insert corresponding closing delimiter at the start offset.
		if (isTouched(curRange.from, openRange)) {
			this.state.pushChange(openRange);
		} else {
			this.state.pushChange({ from: curRange.from, insert: closeDelimStr });
		}
		// Remove closing delimiter when the current range touched it. Otherwise,
		// insert corresponding opening delimiter at the end offset.
		if (isTouched(curRange.to, closeRange)) {
			this.state.pushChange(closeRange);
		} else {
			// This delimiter should be opening. To have the same tag as the original
			// we need to copy the original tag to the newly created one.
			this.state.pushChange({ from: curRange.to, insert: delimStr + tagStr });
		}
	}

	/**
	 * Extend formatting range to cover across the tokens that are in the
	 * current token map, and across the current selection. Should be run
	 * with condition the selection touched at least two tokens, or a token
	 * with the selection range exceeds the token range, at least one of its
	 * side.
	 * 
	 * **Exclusive to inline formatting use.**
	 */
	private _extend(): void {
		let { curRange, delimStr, closeDelimStr, tagStr, curTokenMap, mappedTokens } = this.state,
			tokens = this._parser.getTokens(this.state.level),
			firstTokenIndex = curTokenMap?.[0],
			lastTokenIndex = curTokenMap?.at(-1),
			firstToken = mappedTokens[0],
			lastToken = mappedTokens[mappedTokens.length - 1],
			isLastTokenAtEdge = false,
			fusedRange: PlainRange = { from: firstTokenIndex ?? 0, to: (lastTokenIndex ?? 0) + 1 };
		// If the start offset of the current range touches a token, then
		// eliminate only its closing delimiter.
		if (firstToken && firstToken.from <= curRange.from) {
			let { tagRange, closeRange } = provideTokenPartsRanges(firstToken);
			fusedRange.from++;
			if (tagStr !== undefined) {
				this.state.pushChange(
					firstToken.validTag
						? { from: tagRange.from, to: tagRange.to, insert: tagStr }
						: { from: tagRange.from, insert: tagStr }
				);
			}
			this.state.pushChange(closeRange);
		} else {
			this.state.pushChange({ from: curRange.from, insert: delimStr });
		}
		if (lastToken && lastToken.to >= curRange.to) {
			isLastTokenAtEdge = true;
			fusedRange.to--;
		}
		// Tokens that don't touch one of the current range side have to be fused
		// (i.e. eliminate all of their delimiter).
		for (let i = fusedRange.from; i < fusedRange.to; i++) {
			let tokenIndex = curTokenMap?.[i];
			if (tokenIndex !== undefined) {
				this._remove(tokens[tokenIndex]);
			}
		}
		// If the end offset of the current range touches a token, then eliminate
		// only its opening delimiter.
		if (isLastTokenAtEdge) {
			let { openRange, tagRange } = provideTokenPartsRanges(lastToken!);
			this.state.pushChange(openRange);
			if (lastToken!.validTag) {
				this.state.pushChange(tagRange);
			}
			if (lastToken!.status != TokenStatus.ACTIVE) {
				this.state.pushChange({ from: curRange.to, insert: closeDelimStr });
			}
		} else {
			this.state.pushChange({ from: curRange.to, insert: closeDelimStr });
		}
	}

	/**
	 * Replace the tag of targetted token, or insert as a new if the current
	 * tag was invalid or didn't exist.
	 * 
	 * **Exclusive to inline formatting use.**
	 */
	private _changeInlineTag(token: Token): void {
		let { tagRange } = provideTokenPartsRanges(token),
			{ tagStr, curRange, curSelectionIndex } = this.state;
		if (tagStr === undefined) { return }
		if (!token.validTag) { tagRange.to = tagRange.from }
		this.state.pushChange({ from: tagRange.from, to: tagRange.to, insert: tagStr });
		if (curRange.empty && curRange.from == tagRange.from) {
			this.state.pushSelectionShift(curSelectionIndex, tagStr.length);
		}
	}

	/** Run only when tidier formatting is switched off. */
	private _toggleInlineDelim(): void {
		let { curRange, delimStr } = this.state,
			delimLen = delimStr.length,
			selectedStrWithOverlappedEdge = this.state.doc.sliceString(curRange.from - delimLen, curRange.to + delimLen),
			selectedStr = selectedStrWithOverlappedEdge.slice(delimLen, -delimLen);
		if (_isSurroundedByDelimiter(selectedStr, delimStr)) {
			this.state.pushChange([
				{ from: curRange.from, to: curRange.from + delimLen },
				{ from: curRange.to - delimLen, to: curRange.to }
			]);
		} else if (_isSurroundedByDelimiter(selectedStrWithOverlappedEdge, delimStr)) {
			this.state.pushChange([
				{ from: curRange.from - delimLen, to: curRange.from },
				{ from: curRange.to, to: curRange.to + delimLen }
			]);
		} else {
			let detectWord = false;
			this._wrap(detectWord);
		}
	}

	private _addBlockTag(block: { start: number, end: number }): void {
		let { doc } = this.state,
			{ delimStr } = this.state,
			blockStart = doc.line(block.start),
			blockEnd = doc.line(block.end - 1),
			tagStr = this.state.tagStr ?? "";
		if (!isBlockStart(doc, blockStart)) { delimStr = "\n" + delimStr }
		this.state.pushChange({ from: blockStart.from, insert: delimStr + tagStr });
		if (!isBlockEnd(doc, blockEnd)) {
			this.state.pushChange({ from: blockEnd.to, insert: "\n" });
		}
	}

	private _changeBlockTag(token: Token): void {
		let { tagRange } = provideTokenPartsRanges(token),
			{ tagStr } = this.state;
		this.state.pushChange({ from: tagRange.from, to: tagRange.to, insert: tagStr });
	}

	private _toggleBlockTag(): void {
		let { doc } = this.state,
			blocks = getBlocks(doc, this.state.curRange),
			{ mappedTokens, tagStr } = this.state;
		for (let i = 0, j = 0; i < blocks.length; i++) {
			let block = blocks[i],
				token: Token | undefined = mappedTokens[j],
				blockStart = doc.line(block.start),
				tagRange = token ? getTagRange(token) : undefined;
			if (!token || blockStart.from < token.from) {
				this._addBlockTag(block);
			} else if (token.status != TokenStatus.ACTIVE || blockStart.from > tagRange!.to + 1) {
				this._addBlockTag(block); j++;
			} else if (tagStr === undefined) {
				this._remove(token); j++;
			} else {
				this._changeBlockTag(token); j++;
			}
		}
	}

	/**
	 * Remove formatting based on the token by erasing its delimiter. Should
	 * be run on fused token in `extend()`, or when the cursor is empty and
	 * within the token.
	 */
	private _remove(token: Token): void {
		let { openRange, tagRange, closeRange } = provideTokenPartsRanges(token),
			removedRanges = [openRange, tagRange, closeRange];
		if (!token.validTag) { removedRanges.remove(tagRange) }
		if (token.level == TokenLevel.BLOCK && token.to > tagRange.to) { tagRange.to++ }
		this.state.pushChange(removedRanges);
	}

	private _removeAll(): void {
		do {
			let { mappedTokens } = this.state;
			mappedTokens.forEach(token => {
				this._remove(token);
			});
		} while (this.state.advance());
	}

	private _composeChanges(): ChangeSet {
		return this.state.changeSet = ChangeSet.of(this.state.changes, this.state.doc.length);
	}

	private _remapSelection(): EditorSelection {
		let { selectionRanges, changeSet, selectionShift: selectionChanges } = this.state;
		for (let i = 0; i < selectionRanges.length; i++) {
			let range = selectionRanges[i].map(changeSet),
				shift = selectionChanges[i]?.shift;
			if (shift) {
				range = EditorSelection.range(range.to + shift, range.from + shift);
			}
			selectionRanges[i] = range;
		}
		return this.state.remappedSelection = EditorSelection.create(selectionRanges);
	}

	private _dispatchToView(view: EditorView): void {
		let { changeSet, remappedSelection } = this.state;
		view.dispatch(
			{ changes: changeSet },
			{ selection: remappedSelection, sequential: true }
		);
		this._clearState();
	}
}