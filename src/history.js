/**
 * Snapshot undo with typing coalescence.
 *
 * The stack stores whole documents because the tree is small (a page is a few
 * kilobytes) and whole-document snapshots make undo correct by construction, * there is no inverse operation to get wrong. Coalescing keeps typing cheap:
 * repeated pushes with the same key inside the time window replace the head
 * instead of appending, so one Ctrl+Z removes a sentence rather than a letter.
 *
 * `now` is injectable so the coalescing window can be tested without sleeping.
 */

const clone = (value) =>
  typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));

const sameDoc = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createHistory(initialDoc, options = {}) {
  const limit = options.limit ?? 120;
  const coalesceMs = options.coalesceMs ?? 800;
  const now = options.now ?? (() => Date.now());

  let entries = [{ doc: clone(initialDoc), label: "Opened page" }];
  let index = 0;
  let lastKey = null;
  let lastAt = 0;

  const atHead = () => index === entries.length - 1;

  function push(doc, meta = {}) {
    const label = meta.label || "Edit";
    const key = meta.key || null;
    if (!doc) return false;
    if (sameDoc(entries[index].doc, doc)) return false;

    const timestamp = now();
    if (key && key === lastKey && atHead() && timestamp - lastAt < coalesceMs) {
      entries[index] = { doc: clone(doc), label };
      lastAt = timestamp;
      return true;
    }

    entries = entries.slice(0, index + 1);
    entries.push({ doc: clone(doc), label });
    while (entries.length > limit + 1) entries.shift();
    index = entries.length - 1;
    lastKey = key;
    lastAt = timestamp;
    return true;
  }

  function undo() {
    if (index <= 0) return null;
    index -= 1;
    lastKey = null;
    return clone(entries[index].doc);
  }

  function redo() {
    if (index >= entries.length - 1) return null;
    index += 1;
    lastKey = null;
    return clone(entries[index].doc);
  }

  function reset(doc, label = "Opened page") {
    entries = [{ doc: clone(doc), label }];
    index = 0;
    lastKey = null;
    lastAt = 0;
  }

  return {
    push,
    undo,
    redo,
    reset,
    canUndo: () => index > 0,
    canRedo: () => index < entries.length - 1,
    /** Stop the next push from merging into the current typing burst. */
    breakCoalesce: () => {
      lastKey = null;
    },
    /** Name of the edit that undo would revert / redo would replay. */
    undoLabel: () => (index > 0 ? entries[index].label : null),
    redoLabel: () => (index < entries.length - 1 ? entries[index + 1].label : null),
    size: () => entries.length,
    position: () => index,
  };
}
