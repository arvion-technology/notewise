import test from "node:test";
import assert from "node:assert/strict";

import { createBlock, createDoc } from "../src/blocks.js";
import { countWords, docStats, plainText, readingMinutes, searchBlocks, snippetFor } from "../src/text.js";

const nested = () =>
  createDoc([
    createBlock("heading1", "Field notes", { id: "a" }),
    createBlock("paragraph", "The lane behind the temple was quiet.", {
      id: "b",
      children: [
        createBlock("paragraph", "A brass lamp, still warm.", { id: "c" }),
        createBlock("paragraph", "Quiet again, or quieter.", { id: "d" }),
      ],
    }),
    createBlock("code", "const lane = 'quiet';", { id: "e" }),
  ]);

test("countWords ignores punctuation-only tokens", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   "), 0);
  assert.equal(countWords("hello world"), 2);
  assert.equal(countWords("hello — world"), 2);
  assert.equal(countWords("well-written hyphenated"), 2);
  assert.equal(countWords("42 3.14"), 2);
  assert.equal(countWords("café naïve"), 2);
  assert.equal(countWords("— – •"), 0);
});

test("docStats walks nested blocks", () => {
  const stats = docStats(nested());
  assert.equal(stats.blocks, 5);
  assert.equal(stats.words, 2 + 7 + 5 + 4 + 3);
  assert.equal(stats.readingMinutes, 1);
  assert.ok(stats.characters > stats.words);
});

test("readingMinutes has a one-minute floor once there is text", () => {
  assert.equal(readingMinutes(0), 0);
  assert.equal(readingMinutes(1), 1);
  assert.equal(readingMinutes(220), 1);
  assert.equal(readingMinutes(221), 2);
});

test("plainText joins block text in document order", () => {
  const text = plainText(nested());
  assert.match(text, /^Field notes\nThe lane behind the temple was quiet\./);
  assert.match(text, /A brass lamp, still warm\./);
});

test("searchBlocks is case-insensitive and searches nested blocks", () => {
  const matches = searchBlocks(nested(), "quiet");
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map((match) => match.blockId), ["b", "d", "e"]);
  assert.equal(matches[0].matchStart, 31);
  assert.equal(matches[0].matchEnd, 36);
});

test("searchBlocks returns snippets and respects the limit", () => {
  const doc = createDoc([
    createBlock("paragraph", "alpha beta gamma delta epsilon zeta", { id: "1" }),
    createBlock("paragraph", "alpha again", { id: "2" }),
  ]);
  const [first] = searchBlocks(doc, "alpha", { radius: 6 });
  assert.equal(first.snippet, "alpha beta…");
  assert.equal(searchBlocks(doc, "alpha", { limit: 1 }).length, 1);
  assert.deepEqual(searchBlocks(doc, "   "), []);
  assert.deepEqual(searchBlocks(doc, "missing"), []);
});

test("snippetFor adds ellipses only where text was cut", () => {
  const text = "0123456789 abcdefghij";
  assert.equal(snippetFor(text, 11, 3, 2), "…9 abcde…");
  assert.equal(snippetFor("short abc", 6, 3, 20), "short abc");
});
