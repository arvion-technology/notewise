import test from "node:test";
import assert from "node:assert/strict";

import {
  createBlock,
  createDoc,
  createEmptyDoc,
  deleteBlock,
  duplicateBlock,
  findEntry,
  getBlock,
  getRows,
  indentBlock,
  dedentBlock,
  insertBlockAfter,
  listBlocks,
  mergeWithPrevious,
  moveBlock,
  setBlockType,
  splitBlock,
  toggleChecked,
  trimDepth,
} from "../src/blocks.js";

/** Small explicit tree helpers keep ids stable so assertions stay readable. */
const b = (id, type, text, children = [], extra = {}) => ({ id, type, text, children, ...extra });

const tree = () =>
  createDoc([
    b("b1", "paragraph", "Hello world"),
    b("b2", "bulleted", "Parent", [b("b3", "bulleted", "Child"), b("b4", "bulleted", "After child")]),
    b("b5", "numbered", "First"),
    b("b6", "numbered", "Second"),
  ]);

test("createBlock fills the block shape and rejects unknown types", () => {
  const block = createBlock("todo", "Ship it", { id: "x1", checked: true });
  assert.equal(block.id, "x1");
  assert.equal(block.type, "todo");
  assert.equal(block.text, "Ship it");
  assert.equal(block.checked, true);
  assert.deepEqual(block.children, []);
  assert.throws(() => createBlock("table", ""), /Unknown block type/);
});

test("getRows walks depth-first and numbers each numbered run", () => {
  const rows = getRows(tree());
  assert.deepEqual(rows.map((row) => [row.block.id, row.depth]), [
    ["b1", 0],
    ["b2", 0],
    ["b3", 1],
    ["b4", 1],
    ["b5", 0],
    ["b6", 0],
  ]);
  assert.deepEqual(rows.map((row) => row.marker), [null, "•", "•", "•", "1.", "2."]);
});

test("splitBlock splits text, keeps the tail's children, and returns the caret", () => {
  const doc = createDoc([b("a", "paragraph", "Hello world", [b("c", "paragraph", "child")])]);
  const result = splitBlock(doc, "a", 5);
  assert.ok(result);
  assert.equal(result.caret, 0);
  assert.equal(getBlock(doc, "a").text, "Hello");
  assert.equal(result.block.text, " world");
  assert.deepEqual(getBlock(doc, "a").children, []);
  assert.equal(result.block.children.length, 1);
  assert.equal(result.block.children[0].id, "c");

  const rows = getRows(doc);
  assert.equal(rows[1].block.id, result.block.id);
  assert.equal(rows[1].depth, 0);
});

test("splitBlock defaults to the end and refuses dividers", () => {
  const doc = createDoc([b("a", "paragraph", "abc"), b("d", "divider", "")]);
  const result = splitBlock(doc, "a");
  assert.equal(result.block.text, "");
  assert.equal(getBlock(doc, "a").text, "abc");
  assert.equal(splitBlock(doc, "d", 0), null);
  assert.equal(findEntry(doc, "nope"), null);
});

test("mergeWithPrevious joins text, adopts children, and reports the caret", () => {
  const doc = createDoc([
    b("a", "paragraph", "Hello"),
    b("c", "paragraph", "world", [b("d", "paragraph", "child")]),
  ]);
  const merged = mergeWithPrevious(doc, "c");
  assert.ok(merged);
  assert.equal(merged.caret, 5);
  assert.equal(merged.block.id, "a");
  assert.equal(getBlock(doc, "a").text, "Helloworld");
  assert.equal(getBlock(doc, "d").id, "d");
  assert.equal(findEntry(doc, "a").block.children.length, 1);
  assert.equal(findEntry(doc, "c"), null);
});

test("mergeWithPrevious returns null at the top and joins code with a newline", () => {
  const doc = createDoc([
    b("a", "code", "const a = 1;", [], { lang: "js" }),
    b("c", "code", "const b = 2;", [], { lang: "js" }),
  ]);
  assert.equal(mergeWithPrevious(doc, "a"), null);
  const merged = mergeWithPrevious(doc, "c");
  assert.equal(merged.block.text, "const a = 1;\nconst b = 2;");
});

test("indentBlock nests under the previous sibling and rejects the first block", () => {
  const doc = createDoc([b("a", "paragraph", "one"), b("c", "paragraph", "two")]);
  assert.equal(indentBlock(doc, "a"), false);
  assert.equal(indentBlock(doc, "c"), true);
  const entry = findEntry(doc, "c");
  assert.equal(entry.depth, 1);
  assert.equal(entry.parent.id, "a");
});

test("indentBlock refuses to nest under a divider", () => {
  const doc = createDoc([b("a", "divider", ""), b("c", "paragraph", "two")]);
  assert.equal(indentBlock(doc, "c"), false);
});

test("dedentBlock lifts a block and keeps its trailing siblings as children", () => {
  const doc = tree();
  assert.equal(dedentBlock(doc, "b3"), true);
  const entry = findEntry(doc, "b3");
  assert.equal(entry.depth, 0);
  assert.equal(entry.parent, null);
  // b4 used to follow b3 inside b2, so it moves down with b3.
  const childEntry = findEntry(doc, "b4");
  assert.equal(childEntry.depth, 1);
  assert.equal(childEntry.parent.id, "b3");
  // Order after b2 is: b3 (with b4), then b5, b6.
  assert.deepEqual(doc.blocks.map((block) => block.id), ["b1", "b2", "b3", "b5", "b6"]);
});

test("dedentBlock refuses top-level blocks", () => {
  const doc = tree();
  assert.equal(dedentBlock(doc, "b1"), false);
});

test("moveBlock reorders siblings and across parents without losing the subtree", () => {
  const doc = tree();
  assert.equal(moveBlock(doc, "b1", "b5", "after"), true);
  assert.deepEqual(doc.blocks.map((block) => block.id), ["b2", "b5", "b1", "b6"]);

  // b3 is inside b2; move it after the root-level b6.
  assert.equal(moveBlock(doc, "b3", "b6", "after"), true);
  assert.equal(findEntry(doc, "b3").depth, 0);
  assert.deepEqual(doc.blocks.map((block) => block.id), ["b2", "b5", "b1", "b6", "b3"]);
});

test("moveBlock refuses moving a block into its own subtree", () => {
  const doc = tree();
  const before = JSON.stringify(doc);
  assert.equal(moveBlock(doc, "b2", "b3", "after"), false);
  assert.equal(moveBlock(doc, "b2", "b2", "after"), false);
  assert.equal(JSON.stringify(doc), before);
});

test("duplicateBlock deep-copies the subtree with fresh ids", () => {
  const doc = tree();
  const copy = duplicateBlock(doc, "b2");
  assert.ok(copy);
  assert.notEqual(copy.id, "b2");
  assert.equal(copy.children.length, 2);
  assert.notEqual(copy.children[0].id, "b3");
  assert.equal(copy.children[0].text, "Child");
  assert.deepEqual(doc.blocks.map((block) => block.id).slice(0, 3), ["b1", "b2", copy.id]);
});

test("deleteBlock removes the block and its children", () => {
  const doc = tree();
  assert.equal(deleteBlock(doc, "b2").id, "b2");
  assert.equal(listBlocks(doc).length, 3);
  assert.equal(findEntry(doc, "b3"), null);
  assert.equal(deleteBlock(doc, "missing"), null);
});

test("toggleChecked only applies to todo blocks", () => {
  const doc = createDoc([b("a", "todo", "Ship it", [], { checked: false }), b("c", "paragraph", "text")]);
  assert.equal(toggleChecked(doc, "c"), null);
  assert.equal(toggleChecked(doc, "a"), true);
  assert.equal(toggleChecked(doc, "a"), false);
});

test("setBlockType normalises checked, lang and divider text", () => {
  const doc = createDoc([b("a", "paragraph", "Some text"), b("c", "todo", "done", [], { checked: true })]);
  assert.equal(setBlockType(doc, "a", "todo"), true);
  assert.equal(getBlock(doc, "a").checked, false);
  assert.equal(setBlockType(doc, "a", "code"), true);
  assert.equal(getBlock(doc, "a").lang, "");
  assert.equal("checked" in getBlock(doc, "a"), false);
  assert.equal(setBlockType(doc, "a", "divider"), true);
  assert.equal(getBlock(doc, "a").text, "");
  assert.equal(setBlockType(doc, "c", "paragraph"), true);
  assert.equal("checked" in getBlock(doc, "c"), false);
  assert.equal(setBlockType(doc, "a", "unknown"), false);
});

test("insertBlockAfter creates a sibling at the right index", () => {
  const doc = tree();
  const block = createBlock("paragraph", "Inserted", { id: "new" });
  insertBlockAfter(doc, "b5", block);
  assert.deepEqual(doc.blocks.map((item) => item.id), ["b1", "b2", "b5", "new", "b6"]);
  insertBlockAfter(doc, "b2", createBlock("paragraph", "Nested", { id: "n2" }));
  assert.equal(findEntry(doc, "n2").depth, 0);
});

test("createEmptyDoc always has one editable block", () => {
  const doc = createEmptyDoc();
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].type, "paragraph");
  assert.equal(doc.blocks[0].text, "");
});

test("trimDepth caps imported trees", () => {
  let leaf = b("leaf", "paragraph", "deep");
  for (let i = 0; i < 15; i += 1) leaf = b(`n${i}`, "paragraph", "x", [leaf]);
  const doc = createDoc([leaf]);
  trimDepth(doc, 3);
  assert.equal(listBlocks(doc).length, 4);
});
