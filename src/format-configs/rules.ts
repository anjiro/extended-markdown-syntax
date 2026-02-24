import { Format } from "src/enums";
import { BlockFormat, InlineFormat, BlockFormatRule, InlineFormatRule } from "src/types";

export const BlockRules: Record<BlockFormat, BlockFormatRule> = {
	[Format.FENCED_DIV]: {
		char: ":",
		length: 3,
		exactLen: false,
		class: "fenced-div"
	}
}

export const InlineRules: Record<InlineFormat, InlineFormatRule> = {
	[Format.INSERTION]: {
		char: "+",
		length: 2,
		exactLen: true,
		allowSpace: true,
		mustBeClosed: true,
		class: "ins",
		getEl: () => document.createElement("ins"),
		builtin: false
	},
	[Format.SPOILER]: {
		char: "|",
		length: 2,
		exactLen: true,
		allowSpace: true,
		mustBeClosed: true,
		class: "spoiler",
		getEl: () => {
			let spoilerEl = document.createElement("span");
			spoilerEl.addClass("spoiler");
			spoilerEl.addEventListener("click", (evt) => {
				let spoilerEl = evt.currentTarget as Element,
					isHidden = !spoilerEl.hasClass("spoiler-revealed");
				spoilerEl.toggleClass("spoiler-revealed", isHidden);
			});
			return spoilerEl;
		},
		builtin: false
	},
	[Format.SUPERSCRIPT]: {
		char: "^",
		length: 1,
		exactLen: true,
		allowSpace: false,
		mustBeClosed: true,
		class: "sup",
		getEl: () => document.createElement("sup"),
		builtin: false
	},
	[Format.SUBSCRIPT]: {
		char: "~",
		length: 1,
		exactLen: true,
		allowSpace: false,
		mustBeClosed: true,
		class: "sub",
		getEl: () => document.createElement("sub"),
		builtin: false
	},
	[Format.HIGHLIGHT]: {
		char: ":",
		length: 2,
		exactLen: false,
		allowSpace: true,
		mustBeClosed: false,
		class: "custom-highlight",
		getEl: () => document.createElement("mark"),
		builtin: false
	},
	[Format.CUSTOM_SPAN]: {
		char: "!",
		length: 2,
		exactLen: true,
		allowSpace: true,
		mustBeClosed: true,
		class: "custom-span",
		getEl() {
			let el = document.createElement("span");
			el.classList.add(InlineRules[Format.CUSTOM_SPAN].class);
			return el;
		},
		builtin: false
	}
}

export const Formats = {
	ALL: (() => {
		let formats: Format[] = [];
		for (let format in InlineRules) { formats.push(parseInt(format)) }
		for (let format in BlockRules) { formats.push(parseInt(format)) }
		return formats;
	})(),
	ALL_BLOCK: (() => {
		let formats: BlockFormat[] = [];
		for (let format in BlockRules) { formats.push(parseInt(format)) }
		return formats;
	})(),
	ALL_INLINE: (() => {
		let formats: InlineFormat[] = [];
		for (let format in InlineRules) { formats.push(parseInt(format)) }
		return formats;
	})(),
	SPACE_RESTRICTED_INLINE: (() => {
		let formats: InlineFormat[] = [];
		for (let format in InlineRules) {
			let type = Number.parseInt(format) as InlineFormat;
			if (!InlineRules[type].allowSpace) { formats.push(type) }
		}
		return formats;
	})(),
	SPACE_ALLOWED_INLINE: (() => {
		let formats: InlineFormat[] = [];
		for (let format in InlineRules) {
			let type = Number.parseInt(format) as InlineFormat;
			if (InlineRules[type].allowSpace) { formats.push(type) }
		}
		return formats;
	})(),
	NON_BUILTIN_INLINE: (() => {
		let formats: InlineFormat[] = [];
		for (let format in InlineRules) {
			let type = Number.parseInt(format) as InlineFormat;
			if (!InlineRules[type].builtin) { formats.push(type) }
		}
		return formats;
	})()
}