/**
 * Markdown <-> block tree.
 *
 * The serializer emits one line per block (children indented two spaces, root
 * blocks separated by a blank line) and the parser reads that shape back. Both
 * sides share the same list-numbering rule, so exporting a document, importing
 * it, and exporting again is byte-stable even though block ids change.
 *
 * What intentionally is not modelled: inline emphasis. "**bold**" stays text
 * inside a block, see the README.
 */

import { createBlock, createDoc, isListType } from "./blocks.js";

const INDENT = "  ";
const CALLOUT_MARKER = "[!NOTE]";
const FENCE_RE = /^(`{3,})(.*)$/;
const ESCAPABLE_AFTER_SLASH = /[\s\\#>*+`\-\d]/;

export function toMarkdown(doc) {
  const lines = [];
  emitBlocks(doc?.blocks || [], 0, lines);
  return trimBlankEdges(lines).join("\n");
}

function emitBlocks(blocks, depth, lines) {
  const pad = INDENT.repeat(depth);
  let numberedRun = 0;
  let previousType = null;

  for (const block of blocks) {
    // An empty paragraph has no Markdown representation. Skipping it keeps
    // exports clean; import puts an empty paragraph back on a blank page.
    if (block.type === "paragraph" && block.text === "" && block.children.length === 0) continue;

    if (depth === 0 && lines.length) {
      const tight = isListType(previousType) && isListType(block.type);
      if (!tight && lines[lines.length - 1] !== "") lines.push("");
    }

    numberedRun = block.type === "numbered" ? numberedRun + 1 : 0;

    switch (block.type) {
      case "paragraph":
        lines.push(pad + escapeLine(block.text));
        break;
      case "heading1":
        lines.push(pad + "#" + headingSuffix(block.text));
        break;
      case "heading2":
        lines.push(pad + "##" + headingSuffix(block.text));
        break;
      case "heading3":
        lines.push(pad + "###" + headingSuffix(block.text));
        break;
      case "bulleted":
        lines.push(pad + "-" + itemSuffix(block.text));
        break;
      case "numbered":
        lines.push(pad + numberedRun + "." + itemSuffix(block.text));
        break;
      case "todo":
        lines.push(pad + "- [" + (block.checked ? "x" : " ") + "]" + itemSuffix(block.text));
        break;
      case "quote":
        lines.push(pad + ">" + itemSuffix(block.text));
        break;
      case "callout":
        lines.push(pad + "> " + CALLOUT_MARKER + itemSuffix(block.text));
        break;
      case "code": {
        const fence = fenceFor(block.text);
        lines.push(pad + fence + (block.lang || ""));
        if (block.text.length) lines.push(...block.text.split("\n"));
        lines.push(pad + fence);
        break;
      }
      case "divider":
        lines.push(pad + "---");
        break;
      default:
        lines.push(pad + escapeLine(block.text));
    }

    emitBlocks(block.children, depth + 1, lines);
    if (depth === 0) previousType = block.type;
  }
}

/** "# Heading" with no text still needs to parse back as a heading. */
function headingSuffix(text) {
  return text.length ? " " + escapeLine(text) : "";
}

/** "- item" / "> quote" / "1. item"; an empty item keeps its marker only. */
function itemSuffix(text) {
  return text.length ? " " + escapeLine(text) : "";
}

function fenceFor(text) {
  const runs = text.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Escape only what the parser would otherwise read as structure at line start.
 * Leading backslashes are doubled so the unescape step is lossless.
 */
function escapeLine(text) {
  if (!text) return text;
  if (/^\s/.test(text)) return "\\" + text;
  if (text[0] === "\\") {
    if (text.length === 1 || ESCAPABLE_AFTER_SLASH.test(text[1])) return "\\" + text;
    return text;
  }
  if (/^[#>*+`-]/.test(text)) return "\\" + text;
  if (/^\d{1,9}[.)]\s/.test(text)) return "\\" + text;
  return text;
}

function unescapeLine(text) {
  if (text[0] !== "\\") return text;
  if (text.length > 1 && !ESCAPABLE_AFTER_SLASH.test(text[1])) return text;
  return text.slice(1);
}

export function parseMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const doc = createDoc();
  const stack = []; // stack[depth] = last block seen at that depth
  let index = 0;

  while (index < lines.length) {
    const raw = lines[index];
    if (raw.trim() === "") {
      index += 1;
      continue;
    }

    const leading = raw.match(/^[ \t]*/)[0];
    const depth = Math.min(6, Math.floor(leading.replace(/\t/g, "  ").length / 2));
    let line = raw.slice(leading.length);

    const fence = line.match(FENCE_RE);
    if (fence) {
      const ticks = fence[1];
      const lang = fence[2].trim().split(/\s+/)[0] || "";
      const content = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        if (lines[cursor].trim() === ticks) break;
        content.push(lines[cursor]);
      }
      attach(doc, stack, createBlock("code", content.join("\n"), { lang }), depth);
      index = cursor + 1;
      continue;
    }

    line = line.replace(/[ \t]+$/, "");
    const block = parseLine(line);
    if (block) attach(doc, stack, block, depth);
    index += 1;
  }

  return doc;
}

function parseLine(line) {
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) return createBlock("divider", "");

  let match = line.match(/^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
  if (match) return createBlock("callout", unescapeLine(match[1]));

  match = line.match(/^(#{1,6})(?:\s+(.*))?$/);
  if (match) {
    const level = Math.min(3, match[1].length);
    return createBlock(`heading${level}`, unescapeLine(match[2] || ""));
  }

  match = line.match(/^[-*+]\s+\[([ xX])\]\s*(.*)$/);
  if (match) return createBlock("todo", unescapeLine(match[2]), { checked: match[1].toLowerCase() === "x" });

  match = line.match(/^[-*+](?:\s+(.*))?$/);
  if (match) return createBlock("bulleted", unescapeLine(match[1] || ""));

  match = line.match(/^\d{1,9}[.)](?:\s+(.*))?$/);
  if (match) return createBlock("numbered", unescapeLine(match[1] || ""));

  match = line.match(/^>\s?(.*)$/);
  if (match) return createBlock("quote", unescapeLine(match[1]));

  return createBlock("paragraph", unescapeLine(line));
}

/**
 * Attach a parsed block using the indentation stack. Imported Markdown often
 * jumps two levels at once; clamping to the nearest open parent keeps the tree
 * valid instead of dropping the text.
 */
function attach(doc, stack, block, depth) {
  let level = depth;
  while (level > 0 && !stack[level - 1]) level -= 1;
  if (level === 0) doc.blocks.push(block);
  else stack[level - 1].children.push(block);
  stack[level] = block;
  stack.length = level + 1;
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start += 1;
  while (end > start && lines[end - 1] === "") end -= 1;
  return lines.slice(start, end);
}
