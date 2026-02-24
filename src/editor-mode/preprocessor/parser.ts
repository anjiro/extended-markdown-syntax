import { ChangeSet, Line, Text } from "@codemirror/state";
import { Tree, TreeCursor } from "@lezer/common";
import { PluginSettings, TokenGroup, ChangedRange, PlainRange, InlineFormat, Token } from "src/types";
import { Format, LineCtx, MarkdownViewMode, TokenLevel, TokenStatus } from "src/enums";
import { Formats, InlineRules } from "src/format-configs/rules";
import { handleFencedDivTag, handleInlineTag, Tokenizer } from "src/editor-mode/preprocessor/tokenizer";
import { findNode, getContextFromNode, disableEscape, findShifterAt, getShifterStart, hasInterferer, reenableEscape } from "src/editor-mode/preprocessor/syntax-node";
import { EditorDelimLookup, SKIPPED_NODE_RE } from "src/editor-mode/preprocessor/parser-configs";
import { isBlankLine, getBlockEndAt, TextCursor } from "src/editor-mode/utils/doc-utils";
import { findTokenIndexAt, provideTokenPartsRanges } from "src/editor-mode/utils/token-utils";

/**
 * Used for (re)configuring the state, especially in
 * the case of document or tree change
 */
type ParserStateConfig = {
	doc: Text,
	tree: Tree,
	startAt: number,
	stopAt?: number | Line
	settings: PluginSettings,
}

function _isTerminalChar(char: string, settings: PluginSettings): boolean {
	for (let definedDelim in EditorDelimLookup)
		if (char == definedDelim) return true;

	if (settings.fencedDiv & MarkdownViewMode.EDITOR_MODE && char == ":")
		return true;

	return false;
}

function _composeChanges(changes: ChangeSet): ChangedRange | null {
	if (changes.empty) {
		// Bila tidak terdapat pengubahan, hasilkan null
		return null;
	}
	let from: number, initTo: number, changedTo: number;
	changes.iterChangedRanges((fromA, toA, _, toB) => {
		// [id] Memilih offset terkecil sebagai offset awal pengubahan
		from = from === undefined ? fromA : Math.min(from, fromA);
		// [id] Memilih offset terbesar sebagai offset akhir pengubahan
		initTo = initTo === undefined ? toA : Math.max(initTo, toA);
		changedTo = changedTo === undefined ? toB : Math.max(changedTo, toB);
	}, false);
	return {
		from: from!,
		initTo: initTo!,
		changedTo: changedTo!,
		length: changedTo! - initTo!
	};
}

/**
 * Interferer node is node that, if it was found within the changed range
 * the end offset of stream will be moved forward to the end offset of
 * the new tree. That's including the delimiters of codeblock, mathblock,
 * or comment block.
 */
function _checkInterferer(changedRange: ChangedRange, newTree: Tree, oldTree: Tree): boolean {
	return (
		hasInterferer(newTree, changedRange.from, changedRange.changedTo) ||
		hasInterferer(oldTree, changedRange.from, changedRange.initTo)
	);
}

/**
 * A place storing token based on its type, to be resolved through the
 * `EditorParser` and `EditorParserState` when satisfies certain
 * conditions, such as the token finally reaches its closing delimiter or
 * faces a context boundary.
 */
class _TokenQueue {
	/** Contains all queued tokens (if any), each is paired by its format type. */
	private _tokenMap: Partial<Record<Format, Token>> = {};
	private _state: EditorParserState;

	/**
	 * Attach a state to the queue. Often used when
	 * initializing the parsing.
	 */
	public attachState(state: EditorParserState): void {
		this._state = state;
		this._state.queue = this;
	}

	/** 
	 * Detach currently attached state from the queue. Often used
	 * when the parsing was done.
	 */
	public detachState(): void {
		(this._state.queue as unknown) = undefined;
		(this._state as unknown) = undefined;
	}

	/** Checking whether the token with `type` format is queued or not. */
	public isQueued(type: Format): boolean {
		return !!this._tokenMap[type];
	}

	/** Push a token into the queue, exactly into the token map. */
	public push(token: Token): void {
		// Any token pushed into the queue will instantly be stated as `PENDING`.
		token.status = TokenStatus.PENDING;
		this._tokenMap[token.type] = token;
	}

	/** 
	 * Get queued token as specified by `type` parameter.
	 * Returns `null` if it isn't queued.
	 */
	public getToken(type: Format): Token | null {
		return this._tokenMap[type] ?? null;
	}

	/**
	 * Resolve type-specific token(s) in the queue. Resolving it means
	 * that the token will no longer be in `PENDING` status. Instead, it
	 * will be stated as `ACTIVE` or `INACTIVE` depending on presence of
	 * closing delimiter, if it is required for that. Then, resolved token
	 * will be ejected from the map.
	 * 
	 * @param closed If false and the token's type requires to be closed,
	 * then the token will be resolved as `INACTIVE`. Otherwise, it will
	 * be stated as `ACTIVE`.
	 * 
	 * @param closedByBlankLine Resolved token is either closed by a blank
	 * line or not. It has no effect when `closed` is `true`.
	 * 
	 * @param to Only needed when `closed` is `false`. Used to specify
	 * the end offset of the resolved token.
	 */
	public resolve(types: Format[], closed: boolean, closedByBlankLine: boolean, to = this._state.globalOffset): void {
		for (let type of types) {
			let token = this.getToken(type);
			// If token with this type doesn't exist, then continue to the next one.
			if (!token) continue;

			// When it is an inline token.
			if (token.level == TokenLevel.INLINE) {
				// There is a type -that is highlight- that doesn't need to be closed.
				if (!closed && InlineRules[type as InlineFormat].mustBeClosed) {
					token.status = TokenStatus.INACTIVE;
				} else {
					token.status = TokenStatus.ACTIVE;
				}
			// When it is a block token.
			} else {
				// Block token doesn't need to be closed.
				// Only the validity of its tag affects its status.
				if (token.validTag) {
					token.status = TokenStatus.ACTIVE;
				} else {
					token.status = TokenStatus.INACTIVE;
				}
			}

			// Assign "to" value into token.to when "closed" is false.
			if (!closed) {
				token.to = to;
				// Determine that the resolved token is either located after the blank line or not.
				token.closedByBlankLine = closedByBlankLine;
			}

			// Eject the token from the queue.
			delete this._tokenMap[type];
		}
	}

	/**
	 * Resolve all existing token in the queue. Often used when facing context boundary,
	 * blank line, or table separator. Should be executed without any closing delimiter
	 * has been met.
	 */
	public resolveAll(closedByBlankLine: boolean, to = this._state.globalOffset): void {
		this.resolve(Formats.ALL, false, closedByBlankLine, to);
	}

	/** Clear all queued tokens. */
	public clear(): void {
		this._tokenMap = {};
	}
}

export class EditorParserState {
	public readonly doc: Text;
	public readonly tree: Tree;
	public readonly settings: PluginSettings;
	public readonly textCursor: TextCursor;
	public endOfStream: number;

	public cursor: TreeCursor | null;
	public line: Line;
	public offset: number;
	/** block start */
	public isBlockStart: boolean;

	public inlineTokens: TokenGroup;
	public blockTokens: TokenGroup;
	public queue: _TokenQueue;

	public curCtx: LineCtx = LineCtx.NONE;
	public prevCtx: LineCtx = LineCtx.NONE;

	constructor(config: ParserStateConfig, inlineTokens: TokenGroup, blockTokens: TokenGroup) {
		this.doc = config.doc;
		this.tree = config.tree;
		this.textCursor = TextCursor.atOffset(this.doc, config.startAt);
		this.line = this.textCursor.curLine;
		this.offset = config.startAt - this.line.from;
		this.inlineTokens = inlineTokens;
		this.blockTokens = blockTokens;
		this.cursor = this.tree.cursor();
		this.settings = config.settings;
		this.nextCursor();

		this.endOfStream = config.stopAt instanceof Line
			? config.stopAt.number
			: this.doc.lineAt(config.stopAt ?? this.tree.length).number;

		// if previous line is a blank line or the
		// current line is the first line, then the current one
		// should be a block start
		let prevLine = this.prevLine;
		this.isBlockStart = prevLine
			? isBlankLine(prevLine)
			: true;
	}

	/** global offset */
	public get globalOffset(): number {
		return this.offset + this.line.from;
	}

	public get linePos(): number {
		return this.line.number;
	}

	public get lineStr(): string {
		return this.line.text;
	}

	public get char(): string {
		let char = this.line.text[this.offset];
		if (!char && !this.isLastLine()) {
			return "\n";
		}
		return char ?? "";
	}

	public get prevLine(): Line | null {
		return this.textCursor.getPrevLine();
	}

	public advance(n = 1): boolean {
		let restLen = this.lineStr.length - this.offset;
		if (!restLen) {
			this.queue.resolve(Formats.SPACE_RESTRICTED_INLINE, false, false);
			/* this.inlineQueue.resolve(SpaceRestrictedFormats); */
			return false;
		}

		if (n > restLen)
			this.offset += restLen;
		else
			this.offset += n;

		return true;
	}

	public setGlobalOffset(globalOffset: number): void {
		if (globalOffset > this.doc.length) {
			this.line = this.textCursor.gotoLast().curLine;
			this.offset = this.line.length;
		} else {
			this.line = this.doc.lineAt(globalOffset);
			this.offset = globalOffset - this.line.from;
		}
	}

	public isSpace(side: -1 | 0 | 1 = 0): boolean {
		let char = this.lineStr[this.offset + side];
		return char == " " || char == "\t" || !char;
	}

	public seekWhitespace(maxOffset = this.line.length): number | null {
		let offset = this.offset;
		for (let char = this.line.text[offset]; offset < maxOffset; char = this.line.text[++offset])
			if (char == " " || char == "\t")
				return offset;

		return null;
	}

	public advanceLine(skipBlankLine = true): null | Line {
		if (this.linePos >= this.endOfStream) {
			this.queue.resolveAll(false);
			return null;
		}

		this.textCursor.next()
		this.line = this.textCursor.curLine;
		this.offset = 0;
		this.isBlockStart = false;
		this.resolveContext();
		if (skipBlankLine) this.trySkipBlankLine();
		return this.line;
	}

	public trySkipBlankLine(): boolean {
		if (this.isBlankLine()) {
			// block start can be the line after the blank one.
			this.isBlockStart = true;
			// resolve all tokens that remain in the queue.
			this.queue.resolveAll(true, this.line.to);
			/* this.blockQueue.resolve(this.line.to);
			this.inlineQueue.resolveAll(this.line.to); */
			// if there is trailing blank lines, then skip them all
			while (this.linePos < this.endOfStream) {
				this.textCursor.next();
				this.line = this.textCursor.curLine;
				if (!this.isBlankLine()) break;
			}
			// Is sufficient to resolve the current context once,
			// because a sequence of blank lines should have the
			// same context.
			this.resolveContext();
			return true;
		}
		// returning false indicates that the current line isn't a blank line
		return false;
	}

	public isLastLine(): boolean {
		return this.line.number >= this.doc.lines;
	}

	public isBlankLine(): boolean {
		return isBlankLine(this.line);
	}

	public nextCursor(enter = true): boolean {
		if (this.cursor) {
			if (this.cursor.next(enter) && this.cursor.name != "Document") return true;
			this.cursor = null;
		}
		return false;
	}

	public cursorPos(endSide: 0 | -1 = 0): "after" | "before" | "touch" | null {
		let globalOffset = this.globalOffset;
		if (!this.cursor) return null;
		if (globalOffset < this.cursor.from) return "after";
		if (globalOffset > this.cursor.to + endSide) return "before";
		return "touch";
	}

	public processCursor(): "hl_delim" | "table_sep" | "skipped" | null {
		let cursorPos = this.cursorPos(-1);
		while (cursorPos == "before") {
			this.nextCursor();
			cursorPos = this.cursorPos(-1);
		}
		if (cursorPos != "touch") return null;
		let nodeName = this.cursor!.name;
		if (nodeName.includes("formatting-highlight")) return "hl_delim";
		if (nodeName.includes("table-sep")) return "table_sep";
		if (SKIPPED_NODE_RE.test(nodeName)) return "skipped";
		return null;
	}

	public skipCursorRange(): boolean {
		if (!this.cursor) return false;
		let cursorTo = this.cursor.to - this.line.from,
		whitespaceOffset = this.seekWhitespace(cursorTo);
		if (whitespaceOffset !== null) {
			this.offset = whitespaceOffset;
			this.queue.resolve(Formats.SPACE_RESTRICTED_INLINE, false, false);
			/* this.inlineQueue.resolve(SpaceRestrictedFormats); */
		}
		this.offset = cursorTo;
		return true;
	}

	public getContext(line = this.line): LineCtx {
		if (line.number != this.linePos) {
			let node = findNode(
				this.tree, line.from, line.from,
				(node) => node.parent?.name == "Document"
			);
			if (node) return getContextFromNode(node);
		}
		
		else if (this.cursorPos() == "touch") {
			let node = this.cursor!.node;
			return getContextFromNode(node);
		}

		return LineCtx.NONE;
	}

	public setContext(ctx: LineCtx): void {
		this.prevCtx = this.curCtx;
		this.curCtx = ctx;
	}

	public resolveContext(): void {
		while (this.cursorPos() == "before") this.nextCursor();
		this.setContext(this.getContext());
		let isSkip = false,
			toBeResolved = false,
			includesHl = false,
			offset = this.line.from;
		
		switch (this.curCtx) {
			case LineCtx.HR_LINE:
			case LineCtx.CODEBLOCK:
			case LineCtx.TABLE_DELIM:
				isSkip = true;
				toBeResolved = true;
				break;
			case LineCtx.BLOCKQUOTE:
				if (this.prevCtx != LineCtx.BLOCKQUOTE) {
					toBeResolved = true;
				}
				break;
			case LineCtx.LIST_HEAD:
				includesHl = true;
			// eslint-disable-next-line no-fallthrough
			case LineCtx.HEADING:
			case LineCtx.FOOTNOTE_HEAD:
				toBeResolved = true;
				break;
		}

		switch (this.prevCtx) {
			case LineCtx.HEADING:
			case LineCtx.TABLE:
				toBeResolved = true;
				offset -= 1;
		}

		if (!this.offset) {
			if (toBeResolved) {
				this.queue.resolve(Formats.ALL_BLOCK, false, false, offset);
				this.queue.resolve(Formats.NON_BUILTIN_INLINE, false, false, offset);
				this.isBlockStart = true;
			}
			if (includesHl) this.queue.resolve([Format.HIGHLIGHT], false, false, offset);
		}

		if (isSkip) this.skipCursorRange();
		if (this.curCtx) this.nextCursor();
	}
}

/**
 * The core of editor-mode parser. It only parses the document that in
 * the `tree` range, then stores the result.
 */
export class EditorParser {
	private _state: EditorParserState;
	private _queue: _TokenQueue = new _TokenQueue();
	private _changeSet: ChangeSet | null = null;

	public inlineTokens: TokenGroup = [];
	public blockTokens: TokenGroup = [];

	public reparsedRanges: Record<TokenLevel, { from: number, initTo: number, changedTo: number }>;
	public lastStreamPoint: PlainRange = { from: 0, to: 0 };
	public oldTree: Tree;
	public lastStop: number;

	readonly settings: PluginSettings;

	constructor(settings: PluginSettings) {
		this.settings = settings;
		if (!settings.editorEscape)
			disableEscape();
	}

	/** Get the parsed tokens. */
	public getTokens(level: TokenLevel): TokenGroup {
		return level == TokenLevel.INLINE
			? this.inlineTokens
			: this.blockTokens;
	}

	public hasStoredChanges(): boolean {
		return !!this._changeSet;
	}

	public storeChanges(changeSet: ChangeSet) {
		this._changeSet = this._changeSet
			? this._changeSet.compose(changeSet)
			: changeSet;
	}
	
	/**
	 * Initialize parsing, so the parser would parse from the start of the
	 * document. Should be use when actual initialization, or if there is a
	 * setting change that need the parser to parse from the start.
	 */
	public initParse(doc: Text, tree: Tree, stopAt?: number): void {
		// Toggle escape.
		if (this.settings.editorEscape)
			reenableEscape();
		else
			disableEscape();
		
		// Flush all the results.
		this.lastStreamPoint.from = 0;
		this.inlineTokens = [];
		this.blockTokens = [];

		// Start parsing.
		this._defineState({ doc, tree, startAt: 0, stopAt, settings: this.settings });
		this._streamParse();
		this.reparsedRanges = {
			[TokenLevel.INLINE]: { from: 0, initTo: 0, changedTo: this.inlineTokens.length },
			[TokenLevel.BLOCK]: { from: 0, initTo: 0, changedTo: this.blockTokens.length }
		}

		this.oldTree = tree;
		this.lastStop = stopAt ?? tree.length;

		this._changeSet = null;
	}

	/**
	 * Apply the change comes from the document or the length difference
	 * between previous parsed tree and the current one.
	 */
	public applyChange(doc: Text, tree: Tree, stopAt = tree.length): void {

		// Start stream offset can be the shortest length of both old and new
		// tree, or the start offset of the changed range.
		let changedRange = this._changeSet ? _composeChanges(this._changeSet) : null,
			startStreamOffset = this.lastStop == stopAt
				? stopAt
				: Math.min(stopAt, this.lastStop) + 1;

		this._changeSet = null;

		if (changedRange)
			startStreamOffset = Math.min(startStreamOffset, changedRange.from);

		// Nearest next blank line is the end stream, unless there is no blank
		// line exist within the new tree range, or the changed range encounters
		// such interferer node.
		let endStreamLine = changedRange && _checkInterferer(changedRange, tree, this.oldTree)
			? getBlockEndAt(doc, changedRange.changedTo)
			: getBlockEndAt(doc, stopAt);

		let config: ParserStateConfig = {
			doc, tree,
			startAt: startStreamOffset,
			stopAt: endStreamLine,
			settings: this.settings
		};

		this._defineState(config);
		
		// Tokens that are located after the end of stream will be considered as
		// left tokens, and will be shifted by the length of the changed range.
		let leftTokens: Record<"inline" | "block", TokenGroup> = {
			inline: this._getLeftTokens(
				this._filterTokens(this.inlineTokens, this.reparsedRanges[TokenLevel.INLINE]),
				changedRange,
				endStreamLine
			),
			block: this._getLeftTokens(
				this._filterTokens(this.blockTokens, this.reparsedRanges[TokenLevel.BLOCK]),
				changedRange,
				endStreamLine
			)
		};

		// If there are any terminal characters -are that being used as
		// delimiters- located exactly before the start offset of the stream,
		// then we need to shift it backward.
		this._shiftOffset();

		// Shift the left tokens.
		this._remapLeftTokens(leftTokens.inline, changedRange);
		this._remapLeftTokens(leftTokens.block, changedRange);

		// Start parsing.
		this._streamParse();

		// Post-parsing.
		this.reparsedRanges[TokenLevel.INLINE].changedTo = this.inlineTokens.length;
		this.reparsedRanges[TokenLevel.BLOCK].changedTo = this.blockTokens.length;
		this.inlineTokens = this.inlineTokens.concat(leftTokens.inline);
		this.blockTokens = this.blockTokens.concat(leftTokens.block);
		this.oldTree = tree;
		this.lastStop = stopAt ?? tree.length;
	}

	/** Define new state as parsing begins. */
	private _defineState(config: ParserStateConfig): void {
		this._state = new EditorParserState(config, this.inlineTokens, this.blockTokens);
		this._queue.attachState(this._state);
		if (this.oldTree) this._shiftOffsetByNode();
	}

	/**
	 * Shift the start offset backward to the shifter node if encounters it.
	 * It uses the old tree and the new one, to indetify if there is a
	 * shifter node touching the start offset. Shift can be done if at least
	 * we found it in one of the two trees.
	 * 
	 * Must be done along with defining new state.
	 */
	private _shiftOffsetByNode() {
		let oldOffset = this._state.globalOffset,
			newNode = findShifterAt(this._state.tree, oldOffset),
			oldNode = findShifterAt(this.oldTree, oldOffset),
			newOffset: number | null = null;
		
		// Try to find it in the new tree.
		if (newNode)
			newOffset = getShifterStart(newNode);

		// Try to find it in the old tree, even if shifter be found in the new
		// tree. Because, it could be different type.
		if (oldNode) {
			let oldStart = getShifterStart(oldNode);
			if (oldStart !== null && (newOffset === null || oldStart < newOffset)) {
				newOffset = oldStart;
			}
		}

		if (newOffset !== null) {
			this._state.setGlobalOffset(newOffset);
			return true;
		}

		return false;
	}

	/**
	 * Shift the start offset backward if there is terminal character
	 * located exactly before the offset.
	 */
	private _shiftOffset(): boolean {
		if (this._state.offset == 0) return false;

		let prevOffset = this._state.offset - 1,
			str = this._state.lineStr,
			char = str[prevOffset];
		
		if (_isTerminalChar(char, this.settings)) {
			while (str[prevOffset - 1] == char) { prevOffset-- }
			this._state.offset = prevOffset;
			return true;
		}

		return false;
	}

	/** Detach the state from the parser. Used after finishing the parse. */
	private _detachState(): void {
		this._queue.detachState();
		(this._state as EditorParserState | undefined) = undefined;
	}

	/** Parse the given document. */
	private _streamParse(): void {
		let prevLine: Line | null,
			state = this._state;
		this.lastStreamPoint.from = state.globalOffset;

		// Get previous line context.
		if (prevLine = this._state.prevLine) {
			state.setContext(state.getContext(prevLine));
		}
		// Try to skip current line if it is a blank line. If fails, resolve the
		// current line context.
		if (!state.trySkipBlankLine())
			state.resolveContext();

		// Parse each line untill reach the end of the stream.
		do { this._parseLine() } while (state.advanceLine())
		this.lastStreamPoint.to = state.globalOffset;

		// Flush queue and state.
		this._queue.clear();
		this._detachState();
	}

	/** Parse a single line. */
	private _parseLine(): void {
		let state = this._state;

		// Try to parse block level token.
		if (
			this.settings.fencedDiv & MarkdownViewMode.EDITOR_MODE &&
			this._state.offset == 0 && state.isBlockStart
		) Tokenizer.block(state, Format.FENCED_DIV);

		while (true) {
			// Resolve space-restricted tokens if the state encountered a whitespace.
			if (state.isSpace())
				state.queue.resolve(Formats.SPACE_RESTRICTED_INLINE, false, false);

			let nodeType = state.processCursor(),
				type = EditorDelimLookup[state.char];

			// Running parse on each character.
			if (nodeType == "skipped") {
				state.skipCursorRange();
			} else if (nodeType == "table_sep") {
				state.queue.resolve(Formats.ALL_INLINE, false, false);
				state.advance();
			} else if (type) {
				Tokenizer.inline(state, type);
			} else if (!state.advance()) {
				break;
			}
		}
	}

	private _filterTokens(tokens: TokenGroup, reparsedRange: typeof this.reparsedRanges[TokenLevel]): TokenGroup {
		let reparsedFrom: number | undefined,
			reparsedTo: number | undefined,
			offset = this._state.globalOffset,
			index = findTokenIndexAt(tokens, offset) ?? tokens.length;

		for (let curToken = tokens[index]; index < tokens.length; curToken = tokens[++index]) {
			// Keep find token touched by the current offset
			if (curToken.to < offset) continue;

			let { openRange, tagRange } = provideTokenPartsRanges(curToken);
			if (openRange.to < offset) {
				curToken.to = curToken.from;
				curToken.closeLen = 0;
				reparsedFrom ??= index;
				this._queue.push(curToken);

				if (curToken.tagLen && tagRange.to >= offset) {
					curToken.tagLen = offset - tagRange.from;
					if (curToken.type == Format.CUSTOM_SPAN || curToken.type == Format.HIGHLIGHT)
						handleInlineTag(this._state, curToken);
					else if (curToken.type == Format.FENCED_DIV)
						handleFencedDivTag(this._state, curToken);
				}
			}
			
			else {
				reparsedTo = index + 1;
				break;
			}
		}

		reparsedFrom ??= index;
		reparsedRange.from = reparsedFrom;
		reparsedRange.initTo = reparsedTo ?? index;
		return tokens.splice(index);
	}

	private _getLeftTokens(filteredOut: TokenGroup, changedRange: ChangedRange | null, blockEndLine: Line): TokenGroup {
		let curIndex = 0,
			changedLen = changedRange?.length;

		if (changedLen === undefined) return [];

		while (
			curIndex < filteredOut.length &&
			filteredOut[curIndex].to <= blockEndLine.to - changedLen
		) curIndex++;
		return filteredOut.slice(curIndex);
	}

	private _remapLeftTokens(reusedTokens: TokenGroup, changedRange: ChangedRange | null): void {
		if (!reusedTokens || !changedRange) return;

		let offsetDiffer = changedRange.changedTo - changedRange.initTo;
		for (
			let i = 0, token = reusedTokens[i];
			i < reusedTokens.length;
			token = reusedTokens[++i]
		) {
			token.from += offsetDiffer;
			token.to += offsetDiffer;
		}
	}
}