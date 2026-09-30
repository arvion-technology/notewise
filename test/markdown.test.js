import test from "node:test";
import assert from "node:assert/strict";

import { createBlock, createDoc, getRows } from "../src/blocks.js";
import { parseMarkdown, toMarkdown } from "../src/markdown.js";

function strip(block) {
  const out = { type: block.type, text: block.text, children: block.children.map(strip) };
  if (block.type === "todo") out.checked = Boolean(block.checked);
  if (block.type === "code") out.lang = block.lang || "";
  return out;
}
const shape = (doc) => doc.blocks.map(strip);

function fixture() {
  return createDoc([
    createBlock("heading1", "Notewise", { id: "h1" }),
    createBlock("paragraph", "A plain paragraph with **markdown** left as text.", { id: "p1" }),
    createBlock("bulleted", "First", {
      id: "l1",
      children: [createBlock("bulleted", "Nested", { id: "l2" })],
    }),
    createBlock("numbered", "One", { id: "n1" }),
    createBlock("todo", "Done", { id: "t1", checked: true }),
    createBlock("quote", "Quoted line", { id: "q1" }),
    createBlock("callout", "Read this first", { id: "c1" }),
    createBlock("code", "const answer = 42;\n// `tick` inside code", { id: "code1", lang: "js" }),
    createBlock("divider", "", { id: "d1" }),
    createBlock("paragraph", "Last line", { id: "p2" }),
  ]);
}

test("serializer emits every block type with indentation", () => {
  const md = toMarkdown(fixture());
  assert.match(md, /^# Notewise$/m);
  assert.match(md, /^A plain paragraph with \*\*markdown\*\* left as text\.$/m);
  assert.match(md, /^- First$/m);
  assert.match(md, /^  - Nested$/m);
  assert.match(md, /^1\. One$/m);
  assert.match(md, /^- \[x\] Done$/m);
  assert.match(md, /^> Quoted line$/m);
  assert.match(md, /^> \[!NOTE\] Read this first$/m);
  assert.match(md, /^```js$/m);
  assert.match(md, /^```$/m);
  assert.match(md, /^---$/m);
});

test("markdown round-trips the full block model", () => {
  const original = fixture();
  const md = toMarkdown(original);
  const parsed = parseMarkdown(md);
  assert.deepEqual(shape(parsed), shape(original));
  assert.equal(toMarkdown(parsed), md, "a second export is byte-identical");
});

test("round-trip keeps nested list structure and depth", () => {
  const source = "- one\n  - nested a\n  - nested b\n    - deeper\n- two";
  const parsed = parseMarkdown(source);
  assert.deepEqual(getRows(parsed).map((row) => [row.block.text, row.depth]), [
    ["one", 0],
    ["nested a", 1],
    ["nested b", 1],
    ["deeper", 2],
    ["two", 0],
  ]);
  assert.equal(toMarkdown(parsed), source);
});

test("parser understands headings, todos, quotes, callouts and dividers", () => {
  const md = [
    "# Title",
    "",
    "Intro.",
    "",
    "## Section",
    "",
    "- [x] shipped",
    "- [ ] later",
    "",
    "> quoted",
    "",
    "> [!TIP] a tip",
    "",
    "#### clamped to h3",
    "",
    "***",
  ].join("\n");
  const parsed = parseMarkdown(md);
  const flat = getRows(parsed).map((row) => [row.block.type, row.block.text, row.block.checked]);
  assert.deepEqual(flat, [
    ["heading1", "Title", undefined],
    ["paragraph", "Intro.", undefined],
    ["heading2", "Section", undefined],
    ["todo", "shipped", true],
    ["todo", "later", false],
    ["quote", "quoted", undefined],
    ["callout", "a tip", undefined],
    ["heading3", "clamped to h3", undefined],
    ["divider", "", undefined],
  ]);
});

test("leading Markdown markers in paragraph text survive a round-trip", () => {
  const texts = [
    "# not a heading",
    "- not a bullet",
    "1. not a number",
    "> not a quote",
    "--- not a divider",
    "\\literal backslash",
    " leading space",
    "`not code`",
  ];
  const doc = createDoc(texts.map((text, index) => createBlock("paragraph", text, { id: `p${index}` })));
  const md = toMarkdown(doc);
  const parsed = parseMarkdown(md);
  assert.deepEqual(shape(parsed), shape(doc));
  assert.equal(toMarkdown(parsed), md);
});

test("code fences grow when the code contains backticks", () => {
  const text = "```\nconst x = 1;\n```";
  const doc = createDoc([createBlock("code", text, { id: "c", lang: "js" })]);
  const md = toMarkdown(doc);
  assert.match(md, /^````js$/m);
  assert.equal(parseMarkdown(md).blocks[0].text, text);
  assert.equal(parseMarkdown(md).blocks[0].lang, "js");
});

test("empty blocks with a marker keep their type on round-trip", () => {
  const doc = createDoc([
    createBlock("heading1", "", { id: "a" }),
    createBlock("bulleted", "", { id: "b" }),
    createBlock("numbered", "", { id: "c" }),
    createBlock("todo", "", { id: "d", checked: false }),
  ]);
  const parsed = parseMarkdown(toMarkdown(doc));
  assert.deepEqual(shape(parsed), shape(doc));
});

test("empty paragraphs are omitted from Markdown", () => {
  const doc = createDoc([
    createBlock("paragraph", "", { id: "empty" }),
    createBlock("paragraph", "kept", { id: "kept" }),
  ]);
  assert.equal(toMarkdown(doc), "kept");
});

test("ordered list numbers reset after an interrupting block", () => {
  const doc = createDoc([
    createBlock("numbered", "one", { id: "n1" }),
    createBlock("numbered", "two", { id: "n2" }),
    createBlock("paragraph", "break", { id: "p" }),
    createBlock("numbered", "one again", { id: "n3" }),
  ]);
  const md = toMarkdown(doc);
  assert.match(md, /^1\. one$/m);
  assert.match(md, /^2\. two$/m);
  assert.match(md, /^1\. one again$/m);
  assert.deepEqual(shape(parseMarkdown(md)).map((block) => block.text), ["one", "two", "break", "one again"]);
});

test("parser clamps indentation jumps to the nearest open parent", () => {
  const parsed = parseMarkdown("- a\n      - too deep");
  const rows = getRows(parsed);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[1].block.text, "too deep");
});

test("an unterminated fence keeps the remaining lines as code", () => {
  const parsed = parseMarkdown("```js\nline one\nline two");
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].type, "code");
  assert.equal(parsed.blocks[0].text, "line one\nline two");
});

test("blank lines and CRLF input are tolerated", () => {
  const parsed = parseMarkdown("\r\n\r\n# A\r\n\r\npara\r\n\r\n");
  assert.deepEqual(shape(parsed), [
    { type: "heading1", text: "A", children: [] },
    { type: "paragraph", text: "para", children: [] },
  ]);
});

test("extra list markers are parsed with the text intact", () => {
  const parsed = parseMarkdown("+ plus\n* star\n3. third");
  assert.deepEqual(parsed.blocks.map((block) => [block.type, block.text]), [
    ["bulleted", "plus"],
    ["bulleted", "star"],
    ["numbered", "third"],
  ]);
});

test("an empty source produces an empty document", () => {
  const parsed = parseMarkdown("");
  assert.deepEqual(parsed.blocks, []);
  assert.equal(toMarkdown(parsed), "");
});
