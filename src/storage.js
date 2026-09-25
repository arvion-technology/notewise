/**
 * Persistence is deliberately boring: one versioned JSON blob in localStorage,
 * sanitised on the way back in. Anything malformed is discarded block by block
 * so a broken payload cannot take the app down with a null dereference.
 */

import { BLOCK_TYPES, createBlock, createDoc, nextId } from "./blocks.js";

export const STORAGE_KEY = "notewise.pages.v1";
export const SCHEMA_VERSION = 1;
const MAX_PAGES = 80;
const MAX_BLOCKS = 4000;
const MAX_DEPTH = 12;
const MAX_TEXT = 40_000;

export function createPage({ id, title = "Untitled", blocks, updatedAt = Date.now() } = {}) {
  return {
    id: id || nextId("p"),
    title: String(title).slice(0, 160),
    doc: createDoc(Array.isArray(blocks) ? blocks : [createBlock("paragraph", "")]),
    updatedAt,
  };
}

export function slugify(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

function validId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 80;
}

/**
 * Rebuild a block from untrusted JSON. Unknown types become paragraphs and
 * unknown fields are dropped; the returned tree only contains the block shape
 * the editor knows how to render.
 */
export function sanitizeBlock(input, depth = 0, counter = { count: 0 }) {
  if (!input || typeof input !== "object" || counter.count >= MAX_BLOCKS) return null;
  counter.count += 1;
  const type = BLOCK_TYPES.includes(input.type) ? input.type : "paragraph";
  const rawText = typeof input.text === "string" ? input.text : "";
  const block = createBlock(type, rawText.slice(0, MAX_TEXT), {
    id: validId(input.id) ? input.id : undefined,
    checked: input.checked,
    lang: typeof input.lang === "string" ? input.lang.slice(0, 24) : "",
  });
  if (Array.isArray(input.children) && depth < MAX_DEPTH) {
    for (const child of input.children) {
      const clean = sanitizeBlock(child, depth + 1, counter);
      if (clean) block.children.push(clean);
    }
  }
  return block;
}

export function sanitizeDoc(input) {
  const blocks = [];
  if (input && Array.isArray(input.blocks)) {
    const counter = { count: 0 };
    for (const raw of input.blocks) {
      const block = sanitizeBlock(raw, 0, counter);
      if (block) blocks.push(block);
    }
  }
  return createDoc(blocks);
}

export function sanitizePage(input, now = Date.now()) {
  if (!input || typeof input !== "object") return null;
  return {
    id: validId(input.id) ? input.id : nextId("p"),
    title: typeof input.title === "string" ? input.title.slice(0, 160) : "Untitled",
    doc: sanitizeDoc(input.doc),
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : now,
  };
}

export function encodePages({ pages = [], activeId = null } = {}) {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    activeId,
    pages: pages.map((page) => ({
      id: page.id,
      title: page.title,
      updatedAt: page.updatedAt,
      doc: page.doc,
    })),
  });
}

/** Returns { pages, activeId } or null when there is nothing usable to load. */
export function decodePages(raw, options = {}) {
  if (typeof raw !== "string" || !raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.version !== SCHEMA_VERSION || !Array.isArray(data.pages)) return null;

  const now = options.now ?? Date.now();
  const pages = [];
  const seen = new Set();
  for (const rawPage of data.pages.slice(0, MAX_PAGES)) {
    const page = sanitizePage(rawPage, now);
    if (!page) continue;
    if (seen.has(page.id)) page.id = nextId("p");
    seen.add(page.id);
    pages.push(page);
  }
  if (!pages.length) return null;

  const activeId = pages.some((page) => page.id === data.activeId) ? data.activeId : pages[0].id;
  return { pages, activeId };
}

/**
 * Load from a localStorage-like object. Anything blocked or corrupt falls back
 * to the seed factory so the demo always opens with content.
 */
export function loadPages(storage, seedFactory, options = {}) {
  let raw = null;
  try {
    raw = storage ? storage.getItem(STORAGE_KEY) : null;
  } catch {
    raw = null;
  }
  const restored = raw ? decodePages(raw, options) : null;
  if (restored) return { ...restored, restored: true };

  const seeded = seedFactory ? seedFactory() : null;
  if (seeded && Array.isArray(seeded.pages) && seeded.pages.length) {
    return { pages: seeded.pages, activeId: seeded.activeId || seeded.pages[0].id, restored: false };
  }
  const page = createPage({ title: "Untitled" });
  return { pages: [page], activeId: page.id, restored: false };
}

export function savePages(storage, state) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, encodePages(state));
    return true;
  } catch {
    return false;
  }
}

export function clearPages(storage) {
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
