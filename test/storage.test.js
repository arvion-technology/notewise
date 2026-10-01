import test from "node:test";
import assert from "node:assert/strict";

import { createBlock, createDoc, listBlocks } from "../src/blocks.js";
import {
  clearPages,
  createPage,
  decodePages,
  encodePages,
  loadPages,
  sanitizeBlock,
  sanitizeDoc,
  savePages,
  slugify,
  STORAGE_KEY,
} from "../src/storage.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

const pageOne = () => ({
  id: "p-one",
  title: "One",
  updatedAt: 1700000000000,
  doc: createDoc([
    createBlock("paragraph", "hello", { id: "b1" }),
    createBlock("todo", "done", { id: "b2", checked: true }),
    createBlock("paragraph", "nested", { id: "b3", children: [createBlock("paragraph", "deep", { id: "b4" })] }),
  ]),
});

test("sanitizeBlock rebuilds a clean block and rejects junk", () => {
  const clean = sanitizeBlock({
    id: "x",
    type: "todo",
    text: "ship",
    checked: 1,
    children: [{ type: "nonsense", text: "kept as paragraph" }, null, 42],
  });
  assert.equal(clean.id, "x");
  assert.equal(clean.type, "todo");
  assert.equal(clean.text, "ship");
  assert.equal(clean.checked, true);
  assert.equal(clean.children.length, 1);
  assert.equal(clean.children[0].type, "paragraph");
  assert.equal(sanitizeBlock(null), null);
  assert.equal(sanitizeBlock("junk"), null);
});

test("sanitizeDoc drops blocks that are not objects", () => {
  const doc = sanitizeDoc({ blocks: [{ type: "paragraph", text: "ok" }, null, "nope"] });
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].text, "ok");
  assert.deepEqual(sanitizeDoc(null).blocks, []);
});

test("encode/decode round-trips pages and restores the active page", () => {
  const state = { pages: [pageOne()], activeId: "p-one" };
  const raw = encodePages(state);
  const decoded = decodePages(raw, { now: 1700000000000 });
  assert.equal(decoded.activeId, "p-one");
  assert.equal(decoded.pages[0].title, "One");
  assert.deepEqual(
    listBlocks(decoded.pages[0].doc).map((entry) => entry.block.text),
    ["hello", "done", "nested", "deep"],
  );
  assert.equal(decoded.pages[0].doc.blocks[1].checked, true);
});

test("decodePages rejects corrupt, unversioned and empty payloads", () => {
  assert.equal(decodePages("{not json"), null);
  assert.equal(decodePages(""), null);
  assert.equal(decodePages(JSON.stringify({ version: 99, pages: [pageOne()] })), null);
  assert.equal(decodePages(JSON.stringify({ version: 1, pages: [] })), null);
  assert.equal(decodePages(JSON.stringify({ version: 1, pages: [{ doc: null }] })).pages.length, 1);
});

test("decodePages repairs duplicate ids and a missing active page", () => {
  const raw = JSON.stringify({
    version: 1,
    activeId: "gone",
    pages: [pageOne(), { ...pageOne(), title: "Two" }],
  });
  const decoded = decodePages(raw);
  assert.equal(decoded.pages.length, 2);
  assert.notEqual(decoded.pages[0].id, decoded.pages[1].id);
  assert.equal(decoded.activeId, decoded.pages[0].id);
});

test("loadPages restores valid storage and falls back to the seed factory", () => {
  const storage = memoryStorage({ [STORAGE_KEY]: encodePages({ pages: [pageOne()], activeId: "p-one" }) });
  const loaded = loadPages(storage, () => { throw new Error("seed should not run"); });
  assert.equal(loaded.restored, true);
  assert.equal(loaded.pages[0].id, "p-one");

  const empty = loadPages(memoryStorage(), () => ({ pages: [pageOne()], activeId: "p-one" }));
  assert.equal(empty.restored, false);
  assert.equal(empty.pages.length, 1);
});

test("loadPages survives storage that throws", () => {
  const hostile = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  const loaded = loadPages(hostile, () => ({ pages: [pageOne()], activeId: "p-one" }));
  assert.equal(loaded.pages.length, 1);
  assert.equal(savePages(hostile, { pages: [pageOne()], activeId: "p-one" }), false);
  assert.equal(clearPages(hostile), false);
});

test("savePages writes a payload that decodePages can read back", () => {
  const storage = memoryStorage();
  assert.equal(savePages(storage, { pages: [pageOne()], activeId: "p-one" }), true);
  assert.equal(storage.map.has(STORAGE_KEY), true);
  assert.equal(decodePages(storage.map.get(STORAGE_KEY)).pages[0].title, "One");
  assert.equal(clearPages(storage), true);
  assert.equal(storage.map.has(STORAGE_KEY), false);
});

test("createPage fills sensible defaults", () => {
  const page = createPage({ title: "Draft", updatedAt: 5 });
  assert.equal(page.title, "Draft");
  assert.equal(page.updatedAt, 5);
  assert.equal(page.doc.blocks.length, 1);
  assert.equal(page.doc.blocks[0].type, "paragraph");
});

test("slugify produces safe download names", () => {
  assert.equal(slugify("Field notes — Patan, Tuesday"), "field-notes-patan-tuesday");
  assert.equal(slugify("   "), "untitled");
  assert.equal(slugify("A/B testing"), "a-b-testing");
});
