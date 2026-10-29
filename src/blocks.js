/**
 * The page is a tree of blocks, not an HTML string.
 *
 *   page.doc = { blocks: Block[] }
 *   Block    = { id, type, text, checked?, lang?, children: Block[] }
 *
 * Every structural edit mutates the tree in place and returns a small result
 * object (the new caret position, the block that was merged into, or null when
 * the edit is not allowed). The demo snapshots the tree after each edit, so
 * cloning on every keystroke is unnecessary, the undo stack owns the copies.
 */

export const BLOCK_TYPES = Object.freeze([
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulleted",
  "numbered",
  "todo",
  "quote",
  "code",
  "callout",
  "divider",
]);

/** Types that render a marker in the gutter of the content column. */
const MARKER_TYPES = new Set(["bulleted", "numbered", "todo"]);

export const LIST_TYPES = Object.freeze(["bulleted", "numbered", "todo"]);

const MAX_DEPTH = 12; // imported documents should not be able to build a 10k-deep tree
let sequence = 0;

/** Fresh, collision-resistant id. Tests pass explicit ids where determinism matters. */
export function nextId(prefix = "b") {
  sequence += 1;
  return `${prefix}-${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function isListType(type) {
  return LIST_TYPES.includes(type);
}

export function hasMarker(type) {
  return MARKER_TYPES.has(type);
}

export function createBlock(type = "paragraph", text = "", options = {}) {
  if (!BLOCK_TYPES.includes(type)) throw new TypeError(`Unknown block type: ${type}`);
  const block = {
    id: options.id || nextId(),
    type,
    text: text == null ? "" : String(text),
    children: Array.isArray(options.children) ? options.children : [],
  };
  if (type === "todo") block.checked = Boolean(options.checked);
  if (type === "code") block.lang = typeof options.lang === "string" ? options.lang : "";
  return block;
}

export function createDoc(blocks = []) {
  return { blocks: Array.isArray(blocks) ? blocks : [] };
}

/** Locate a block and the array it lives in. Useful for every structural edit. */
export function findEntry(doc, id) {
  return locate(doc.blocks, id, null, 0);
}

function locate(blocks, id, parent, depth) {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.id === id) return { block, parent, siblings: blocks, index, depth };
    const found = locate(block.children, id, block, depth + 1);
    if (found) return found;
  }
  return null;
}

export function getBlock(doc, id) {
  return findEntry(doc, id)?.block ?? null;
}

/** Every block in document order, with its parent and depth. */
export function listBlocks(doc) {
  const out = [];
  const walk = (blocks, parent, depth) => {
    for (const block of blocks) {
      out.push({ block, parent, depth });
      walk(block.children, block, depth + 1);
    }
  };
  walk(doc.blocks, null, 0);
  return out;
}

/**
 * The render list. Depth-first order plus the marker a list item needs.
 * Numbering restarts whenever a non-list block interrupts a numbered run,
 * and separately inside each parent, the same rule the Markdown serializer uses.
 */
export function getRows(doc) {
  const rows = [];
  const walk = (blocks, parentId, depth) => {
    let run = 0;
    for (const block of blocks) {
      run = block.type === "numbered" ? run + 1 : 0;
      let marker = null;
      if (block.type === "bulleted") marker = "•";
      else if (block.type === "numbered") marker = `${run}.`;
      else if (block.type === "todo") marker = "";
      rows.push({ block, depth, parentId, marker });
      walk(block.children, block.id, depth + 1);
    }
  };
  walk(doc.blocks, null, 0);
  return rows;
}

export function countBlocks(doc) {
  return listBlocks(doc).length;
}

/** True when `id` is the block itself or one of its descendants. */
export function containsBlock(block, id) {
  if (!block) return false;
  if (block.id === id) return true;
  return block.children.some((child) => containsBlock(child, id));
}

function insertionList(doc, parentId) {
  if (!parentId) return doc.blocks;
  const parent = getBlock(doc, parentId);
  return parent ? parent.children : doc.blocks;
}

export function appendBlock(doc, block, parentId = null) {
  insertionList(doc, parentId).push(block);
  return block;
}

/** Insert as the next sibling of `refId`; null pushes to the end of the root. */
export function insertBlockAfter(doc, refId, block) {
  const entry = refId ? findEntry(doc, refId) : null;
  if (!entry) {
    doc.blocks.push(block);
    return block;
  }
  entry.siblings.splice(entry.index + 1, 0, block);
  return block;
}

export function insertBlockBefore(doc, refId, block) {
  const entry = refId ? findEntry(doc, refId) : null;
  if (!entry) {
    doc.blocks.unshift(block);
    return block;
  }
  entry.siblings.splice(entry.index, 0, block);
  return block;
}

export function insertBlockAt(doc, block, parentId, index) {
  const list = insertionList(doc, parentId);
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, list.length)) : list.length;
  list.splice(at, 0, block);
  return block;
}

/**
 * Split a block at a caret offset. The tail becomes a new sibling of the same
 * type, and the original block's children move with the tail, that is what
 * editors do when you press Enter halfway through a parent block.
 */
export function splitBlock(doc, id, offset = null) {
  const entry = findEntry(doc, id);
  if (!entry || entry.block.type === "divider") return null;
  const { block, siblings, index } = entry;
  const at = offset == null ? block.text.length : clamp(Number(offset), 0, block.text.length);
  const tail = block.text.slice(at);
  block.text = block.text.slice(0, at);

  const next = createBlock(block.type, tail, {
    checked: block.checked,
    lang: block.lang,
  });
  next.children = block.children;
  block.children = [];
  siblings.splice(index + 1, 0, next);
  return { block: next, caret: 0 };
}

/**
 * Backspace at the start of a block: append its text to the previous sibling.
 * Returns null when there is no previous sibling, the caller then tries
 * dedentBlock instead. Divider blocks have no text so they are not mergeable.
 */
export function mergeWithPrevious(doc, id) {
  const entry = findEntry(doc, id);
  if (!entry || entry.index === 0) return null;
  const previous = entry.siblings[entry.index - 1];
  if (previous.type === "divider") return null;

  const caret = previous.text.length;
  const glue = previous.type === "code" || entry.block.type === "code" ? "\n" : "";
  previous.text += glue + entry.block.text;
  if (entry.block.children.length) previous.children.push(...entry.block.children);
  entry.siblings.splice(entry.index, 1);
  return { block: previous, caret };
}

/**
 * Move a block (with its subtree) before or after another block. Moving a
 * block inside itself is rejected: that would detach the tree from the page.
 */
export function moveBlock(doc, id, targetId, position = "after") {
  if (!id || !targetId || id === targetId) return false;
  const source = findEntry(doc, id);
  const target = findEntry(doc, targetId);
  if (!source || !target) return false;
  if (containsBlock(source.block, targetId)) return false;

  source.siblings.splice(source.index, 1);
  const destination = findEntry(doc, targetId);
  if (!destination) return false;
  const at = position === "before" ? destination.index : destination.index + 1;
  destination.siblings.splice(at, 0, source.block);
  return true;
}

/** Tab: make the block the last child of its previous sibling. */
export function indentBlock(doc, id) {
  const entry = findEntry(doc, id);
  if (!entry || entry.index === 0) return false;
  const previous = entry.siblings[entry.index - 1];
  if (previous.type === "divider") return false;
  entry.siblings.splice(entry.index, 1);
  previous.children.push(entry.block);
  return true;
}

/**
 * Shift-Tab: move the block out one level. The siblings that followed it stay
 * attached to it as children, which is the behaviour people expect from an
 * outdent in the middle of a list.
 */
export function dedentBlock(doc, id) {
  const entry = findEntry(doc, id);
  if (!entry || entry.depth === 0) return false;
  const parent = entry.parent;
  if (!parent) return false;
  const parentEntry = findEntry(doc, parent.id);
  if (!parentEntry) return false;

  const trailing = parent.children.splice(entry.index + 1);
  parent.children.splice(entry.index, 1);
  entry.block.children.push(...trailing);
  parentEntry.siblings.splice(parentEntry.index + 1, 0, entry.block);
  return true;
}

export function setBlockType(doc, id, type) {
  if (!BLOCK_TYPES.includes(type)) return false;
  const block = getBlock(doc, id);
  if (!block || block.type === type) return false;
  block.type = type;
  if (type === "todo") block.checked = Boolean(block.checked);
  else delete block.checked;
  if (type === "code") block.lang = block.lang || "";
  else delete block.lang;
  if (type === "divider") block.text = "";
  return true;
}

export function setBlockText(doc, id, text) {
  const block = getBlock(doc, id);
  if (!block) return false;
  block.text = text == null ? "" : String(text);
  return true;
}

export function toggleChecked(doc, id) {
  const block = getBlock(doc, id);
  if (!block || block.type !== "todo") return null;
  block.checked = !block.checked;
  return block.checked;
}

export function setChecked(doc, id, checked) {
  const block = getBlock(doc, id);
  if (!block || block.type !== "todo") return null;
  block.checked = Boolean(checked);
  return block.checked;
}

export function deleteBlock(doc, id) {
  const entry = findEntry(doc, id);
  if (!entry) return null;
  entry.siblings.splice(entry.index, 1);
  return entry.block;
}

function cloneSubtree(block) {
  const copy = createBlock(block.type, block.text, {
    checked: block.checked,
    lang: block.lang,
  });
  copy.children = block.children.map(cloneSubtree);
  return copy;
}

export function duplicateBlock(doc, id) {
  const entry = findEntry(doc, id);
  if (!entry) return null;
  const copy = cloneSubtree(entry.block);
  entry.siblings.splice(entry.index + 1, 0, copy);
  return copy;
}

/** A single editable block for an empty page; the demo never ships a naked doc. */
export function createEmptyDoc() {
  return createDoc([createBlock("paragraph", "")]);
}

/** Keep depth bounded for trees that came from storage or a parser. */
export function trimDepth(doc, maxDepth = MAX_DEPTH) {
  const walk = (blocks, depth) => {
    for (const block of blocks) {
      if (depth >= maxDepth) {
        block.children = [];
        continue;
      }
      walk(block.children, depth + 1);
    }
  };
  walk(doc.blocks, 0);
  return doc;
}

function clamp(value, min, max) {
  const n = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, n));
}
