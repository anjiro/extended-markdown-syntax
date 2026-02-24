import { Format, TokenLevel, Delimiter, TokenStatus } from "src/enums";
import { BlockFormat, InlineFormat, Token } from "src/types";
import { BlockRules, InlineRules } from "src/format-configs/rules";
import { EditorParserState } from "src/editor-mode/preprocessor/parser";
import { isInlineFormat } from "src/format-configs/format-utils";

/** Describe the rule that has to be satisfied by the delimiter */
interface DelimSpec {
	/** Should be single character */
	char: string,
	/** Delimiter length */
	length: number,
	/**
	 * If true, then delimiter length must be the same as
	 * in the predetermined rule. Otherwise, the defined length
	 * act as minimum length.
	 */
	exactLen: boolean,
	/** Should be `Delimiter.OPEN` or `Delimiter.CLOSE` */
	role: Delimiter,
	/**
	 * When true, any space after the opening delimiter or before the closing
	 * one doesn't make the delimiter invalid. Default is false.
	 */
	allowSpaceOnDelim?: boolean
}

function _isAlphanumeric(char: string): boolean {
	let charCode = char.charCodeAt(0);
	return (
		charCode >= 0x30 && charCode <= 0x39 ||
		charCode >= 0x41 && charCode <= 0x5a ||
		charCode >= 0x61 && charCode <= 0x7a
	);
}

function _retrieveDelimSpec(type: Format, role: Delimiter): DelimSpec {
	let char: string, length: number, exactLen: boolean, allowSpaceOnDelim: boolean;
	if (isInlineFormat(type)) {
		({ char, length, exactLen } = InlineRules[type]);
		allowSpaceOnDelim = false;
	} else {
		({ char, length, exactLen } = BlockRules[type]);
		allowSpaceOnDelim = true;
	}
	return { char, length, exactLen, role, allowSpaceOnDelim }
}


function _validateDelim(str: string, offset: number, spec: DelimSpec): { valid: boolean, length: number } {
	let length = 0, valid = false;
	while (str[offset + length] == spec.char) length++;
	if (spec.exactLen && length == spec.length || !spec.exactLen && length >= spec.length) {
		let char: string;
		if (spec.role == Delimiter.OPEN) {
			char = str[offset + length];
		} else if (spec.role == Delimiter.CLOSE) {
			char = str[offset - 1];
		} else {
			throw TypeError("");
		}
		if (spec.allowSpaceOnDelim || char && char != " " && char != "\t") { valid = true }
	}
	return { valid, length };
}

function _handleClosingDelim(state: EditorParserState, token: Token, closeLen: number): void {
	token.closeLen = closeLen;
	token.to = state.globalOffset + closeLen;
	state.advance(closeLen);
	state.queue.resolve([token.type], true, false);
}

export function handleInlineTag(state: EditorParserState, token: Token): void {
	let offset = state.offset,
		initTagLen = token.tagLen,
		str = state.lineStr;
	if (token.type == Format.HIGHLIGHT) {
		// New syntax: Color: (alphanumeric name followed by colon)
		if (token.validTag) {
			if (str[offset - 1] == ":") return;
			token.validTag = false;
		}
		for (let char = str[offset]; offset < str.length; char = str[++offset]) {
			if (!_isAlphanumeric(char) && char != "-") break;
			token.tagLen++;
		}
		if (token.tagLen > 0 && str[offset] == ":") {
			token.validTag = true;
			token.tagLen++;
		}
	} else {
		// Existing syntax: {tag} (used by CUSTOM_SPAN)
		if (token.validTag) {
			if (str[offset - 1] == "}") return;
			token.validTag = false;
		}
		if (token.tagLen == 0) {
			if (str[offset] != "{") return;
			token.tagLen++;
			offset++;
		}
		for (let char = str[offset]; offset < str.length; char = str[++offset]) {
			if (!_isAlphanumeric(char) && char != "-" && char != " ") break;
			token.tagLen++;
		}
		if (token.tagLen > 1 && str[offset] == "}") {
			token.validTag = true;
			token.tagLen++;
		}
	}
	state.advance(token.tagLen - initTagLen);
}

export function handleFencedDivTag(state: EditorParserState, token: Token): void {
	token.validTag = false;
	let offset = token.openLen + token.tagLen,
		initTagLen = token.tagLen,
		str = state.lineStr;
	while (offset < str.length) {
		let char = str[offset];
		if (char == " " || char == "-" || _isAlphanumeric(char)) { token.tagLen++; offset++ }
		else break;
	}
	state.advance(token.tagLen - initTagLen);
	if (offset >= str.length) token.validTag = true;
	else state.queue.resolve([token.type], false, false);
}

/**
 * Tokens will only be created through this. Each method
 * returns whether `true` or `false`, indicating the success
 * of the tokenization. Parsed token will be automatically
 * inserted to the token group.
 */
export const Tokenizer = {
	/**
	 * Used for parsing block token. Should only be executed when the
	 * current line was a block start.
	 */
	block(state: EditorParserState, type: BlockFormat): boolean {
		// Block token is only parsed when the current line is a block start.
		if (!state.isBlockStart) return false;
		// Retrieve DelimSpec based on input type.
		let spec = _retrieveDelimSpec(type, Delimiter.OPEN),
			// Verifiy that the delimiter was valid and gets its length.
			{ valid, length: openLen } = _validateDelim(state.lineStr, state.offset, spec);
		// If it isn't valid, then abort it without advancing, so inline
		// delimiters sharing the same character can still be processed.
		if (!valid) return false;
		// Advance along the given delimiter length.
		state.advance(openLen);
		let token: Token = {
			type,
			level: TokenLevel.BLOCK,
			status: TokenStatus.PENDING,
			from: state.globalOffset - openLen,
			to: state.globalOffset - openLen,
			openLen,
			closeLen: 0,
			tagLen: 0,
			// Block tag doesn't overlapped over the content.
			tagAsContent: false,
			validTag: false,
			closedByBlankLine: false
		};
		// Queue and push the token to the token group.
		state.blockTokens.push(token);
		state.queue.push(token);
		// Currently, block token only has fenced div type. Therefore,
		// the tokenizer parses its tag directly without checking its
		// type.
		handleFencedDivTag(state, token);
		// Indicate that tokenizing run successfully. 
		return true;
	},

	/** 
	 * Used for parsing inline token. Should be executed twice only when the
	 * parser state encountered allegedly closing delimiter of the queued token.
	 */
	inline(state: EditorParserState, type: InlineFormat): boolean {
		// Get the token according to the input type, may be null.
		let token = state.queue.getToken(type),
			// Which delimiter is encountered by the state.
			// Determined by the presence of queued token.
			role = state.queue.isQueued(type) ? Delimiter.CLOSE : Delimiter.OPEN,
			// Get delimiter specification according to its type.
			spec = _retrieveDelimSpec(type, role),
			// Check whether it's highlight, custom span, or neither.
			isHighlight = type == Format.HIGHLIGHT,
			isCustomSpan = type == Format.CUSTOM_SPAN,
			// Verifiy that the delimiter was valid and gets its length.
			{ valid, length } = _validateDelim(state.lineStr, state.offset, spec);
		// If it isn't valid, then abort it.
		if (!valid) {
			state.advance(length);
			return false;
		}
		// If there is a queued token with this type, then finalize it.
		if (token)
			_handleClosingDelim(state, token, length);
		// Else, create new token and push it into the queue.
		else {
			let token: Token = {
				type,
				level: TokenLevel.INLINE,
				status: TokenStatus.PENDING,
				from: state.globalOffset,
				to: state.globalOffset,
				openLen: length,
				closeLen: 0,
				tagLen: 0,
				tagAsContent: isHighlight || isCustomSpan,
				validTag: false,
				closedByBlankLine: false
			};
			state.inlineTokens.push(token);
			state.queue.push(token);
			state.advance(length);
			// If this token can have a tag, then try to parse it.
			if (isHighlight || isCustomSpan) handleInlineTag(state, token);
		}
		return true;
	}
}