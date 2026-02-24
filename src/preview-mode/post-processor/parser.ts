import { Format } from "src/enums";
import { InlineFormat } from "src/types";
import { Formats, InlineRules } from "src/format-configs/rules";
import { SKIPPED_CLASSES, PreviewDelimLookup } from "src/preview-mode/post-processor/configs";

function _hasClasses(el: Element, classes: string[]): boolean {
	for (let cls of classes)
		if (el.classList.contains(cls)) return true;
	return false;
}

function _isWhitespace(char: string): boolean {
	return char == " " || char == "\n" || char == "\t";
}

export class PreviewModeParser {
	public root: Element;

	private _walker: TreeWalker;
	private _offset = 0;
	private _curNode: Node;
	private _nodeChanged = false;
	private _stack: InlineFormat[] = [];
	private _queue: Partial<Record<InlineFormat, Range>> = {}
	private _parsingQueue: PreviewModeParser[];

	constructor(root: Element, parsingQueue: PreviewModeParser[]) {
		this.root = root;
		this._walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		this._walker.nextNode();
		this._curNode = this._walker.currentNode;
		this._parsingQueue = parsingQueue;
	}

	public streamParse(): void {
		do {
			if (this._curNode instanceof Text) {
				this._offset = 0;
				this._parseTextNode();
			} else if (this._curNode instanceof Element) {
				if (this._isSkipped(this._curNode)) {
					this._resolve(Format.SUPERSCRIPT);
					this._resolve(Format.SUBSCRIPT);
				} else if (this._curNode.textContent) {
					this._parsingQueue.push(new PreviewModeParser(this._curNode, this._parsingQueue));
					if (/\s/.test(this._curNode.textContent)) {
						this._resolve(Format.SUPERSCRIPT);
						this._resolve(Format.SUBSCRIPT);
					}
				}
			}
		} while (this._nextNode());
		this._forceResolveAll();
	}

	private _parseTextNode(): void {
		let str = this._curNode.textContent ?? "";
		while (!this._nodeChanged && this._offset < str.length) {
			let char = str[this._offset],
				type = PreviewDelimLookup[char];
			if (char == " " || char == "\n" || char == "\t") {
				this._resolve(Format.SUPERSCRIPT);
				this._resolve(Format.SUBSCRIPT);
				this._offset++;
				continue;
			}
			if (!type) {
				this._offset++;
				continue;
			}
			this._tokenize(type);
		}
		this._nodeChanged = false;
	}

	private _finalize(type: InlineFormat, open: Range, content: Range, close: Range): void {
		let wrapper = InlineRules[type].getEl();
		close.deleteContents();
		content.surroundContents(wrapper);
		open.deleteContents();
		if (wrapper == this._curNode.nextSibling) {
			this._nextNode();
		} else {
			this._prevNode();
		}
		this._nodeChanged = true;
	}

	private _resolve(type: InlineFormat, close?: Range): void {
		if (close && this._queue[type]) {
			let content = new Range(),
				open = this._queue[type];
			content.setStart(open.endContainer, open.endOffset);
			content.setEnd(close.startContainer, close.startOffset);
			this._stack.findLast((t, i) => {
				delete this._queue[t];
				if (t == type) {
					this._stack.splice(i);
					return true;
				}
			});
			this._finalize(type, open, content, close);
		} else {
			delete this._queue[type];
			this._stack = this._stack.filter(t => t != type);
		}
	}

	private _forceResolveAll(): void {
		for (let i = 0; i < Formats.ALL_INLINE.length; i++)
			this._resolve(Formats.ALL_INLINE[i]);
	}

	private _tokenize(type: InlineFormat): boolean {
		let { length: reqLength, char } = InlineRules[type],
			str = this._curNode.textContent!,
			length = 0,
			hasOpen = !!this._queue[type],
			hasSpaceBefore = _isWhitespace(str[this._offset - 1]),
			hasSpaceAfter: boolean;

		while (str[this._offset] == char) { this._offset++; length++ }
		hasSpaceAfter = _isWhitespace(str[this._offset]);
		// HIGHLIGHT: opening accepts 1 or 2 colons; closing requires exactly 2 colons
		let invalidLength = type == Format.HIGHLIGHT
			? (hasOpen ? length != 2 : length != 1 && length != 2)
			: length != reqLength;
		if (hasOpen && hasSpaceBefore || !hasOpen && hasSpaceAfter || invalidLength) return false;

		let range = new Range();
		range.setStart(this._curNode, this._offset - length);
		range.setEnd(this._curNode, this._offset);
		this._pushDelim(type, range);
		return true;
	}

	private _pushDelim(type: InlineFormat, delim: Range): void {
		if (this._queue[type]) {
			this._resolve(type, delim);
		} else {
			this._queue[type] = delim;
			this._stack.push(type);
		}
	}

	private _nextNode(): boolean {
		if (this._walker.nextSibling()) {
			this._curNode = this._walker.currentNode;
			return true;
		} else {
			return false;
		}
	}

	private _prevNode(): boolean {
		if (this._walker.previousSibling()) {
			this._curNode = this._walker.currentNode;
			return true;
		}
		return false;
	}

	private _isSkipped(el: Element): boolean {
		return (
			_hasClasses(el, SKIPPED_CLASSES) ||
			el.tagName == "CODE" || el.tagName == "IMG"
		);
	}
}