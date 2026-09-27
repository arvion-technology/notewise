/**
 * Document statistics and block search. Both walk the tree, so they stay
 * correct when blocks are nested; neither touches the DOM.
 */

import { listBlocks } from "./blocks.js";

const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Words are whitespace-separated tokens that contain at least one letter or
 * digit, so a lone em dash or bullet is not counted as a word.
 */
export function countWords(text) {
  const value = String(text ?? "").trim();
  if (!value) return 0;
  let words = 0;
  for (const token of value.split(/\s+/)) {
    if (HAS_LETTER_OR_NUMBER.test(token)) words += 1;
  }
  return words;
}

export function readingMinutes(words, wordsPerMinute = 220) {
  if (!words) return 0;
  return Math.max(1, Math.ceil(words / wordsPerMinute));
}

export function docStats(doc) {
  let words = 0;
  let characters = 0;
  let blocks = 0;
  for (const { block } of listBlocks(doc)) {
    blocks += 1;
    words += countWords(block.text);
    characters += block.text.length;
  }
  return {
    words,
    characters,
    blocks,
    readingMinutes: readingMinutes(words),
  };
}

export function plainText(doc) {
  return listBlocks(doc)
    .map(({ block }) => block.text)
    .filter(Boolean)
    .join("\n");
}

/** A short window around a match, with ellipses where text was cut. */
export function snippetFor(text, start, length, radius = 36) {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, start + length + radius);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`;
}

/**
 * Case-insensitive block search across the whole tree. Returns the first match
 * per block in document order, capped by `limit`, with a snippet for the
 * sidebar result list.
 */
export function searchBlocks(doc, query, options = {}) {
  const needle = String(query ?? "").trim();
  if (!needle) return [];
  const lower = needle.toLowerCase();
  const limit = options.limit ?? 12;
  const radius = options.radius ?? 36;
  const matches = [];

  for (const { block, depth } of listBlocks(doc)) {
    const text = block.text || "";
    const at = text.toLowerCase().indexOf(lower);
    if (at === -1) continue;
    matches.push({
      blockId: block.id,
      type: block.type,
      depth,
      text,
      matchStart: at,
      matchEnd: at + needle.length,
      snippet: snippetFor(text, at, needle.length, radius),
    });
    if (matches.length >= limit) break;
  }
  return matches;
}
