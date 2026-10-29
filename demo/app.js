/**
 * Notewise, demo application.
 *
 * Everything structural lives in ../src: the block tree, the Markdown codec,
 * the undo stack, statistics and persistence. This file owns the DOM: render
 * the tree, map caret positions, and translate keys into tree operations.
 */

import {
  countBlocks,
  createBlock,
  dedentBlock,
  deleteBlock,
  duplicateBlock,
  getBlock,
  getRows,
  indentBlock,
  insertBlockAfter,
  mergeWithPrevious,
  moveBlock,
  setBlockType,
  splitBlock,
  toggleChecked,
} from "../src/blocks.js";
import { createHistory } from "../src/history.js";
import { parseMarkdown, toMarkdown } from "../src/markdown.js";
import { docStats, searchBlocks } from "../src/text.js";
import { createPage, loadPages, savePages, slugify } from "../src/storage.js";
import { seedPages } from "./seed.js";

const $ = A.$;
const $$ = A.$$;
const fmt = A.fmt;
const toast = A.toast;

/* ------------------------------------------------------------- constants -- */

const TYPE_LABELS = {
  paragraph: "Text",
  heading1: "Heading 1",
  heading2: "Heading 2",
  heading3: "Heading 3",
  bulleted: "Bulleted list",
  numbered: "Numbered list",
  todo: "To-do",
  quote: "Quote",
  code: "Code block",
  callout: "Callout",
  divider: "Divider",
};

const PLACEHOLDERS = {
  paragraph: "Write, or type / for commands",
  heading1: "Heading 1",
  heading2: "Heading 2",
  heading3: "Heading 3",
  bulleted: "List item",
  numbered: "List item",
  todo: "To-do",
  quote: "Quote",
  code: "Code",
  callout: "Callout",
};

const SLASH_COMMANDS = [
  { id: "paragraph", label: "Text", hint: "Plain paragraph", icon: "¶", keywords: "text paragraph plain body" },
  { id: "heading1", label: "Heading 1", hint: "Section title", icon: "H1", keywords: "h1 heading title section" },
  { id: "heading2", label: "Heading 2", hint: "Sub-section", icon: "H2", keywords: "h2 heading subtitle" },
  { id: "heading3", label: "Heading 3", hint: "Small heading", icon: "H3", keywords: "h3 heading" },
  { id: "bulleted", label: "Bulleted list", hint: "Unordered item", icon: "•", keywords: "bullet list unordered" },
  { id: "numbered", label: "Numbered list", hint: "Ordered item", icon: "1.", keywords: "number ordered list" },
  { id: "todo", label: "To-do", hint: "Checkbox item", icon: "□", keywords: "todo task check checkbox" },
  { id: "quote", label: "Quote", hint: "Standfirst or citation", icon: "❝", keywords: "quote blockquote citation" },
  { id: "code", label: "Code block", hint: "Monospace block", icon: "</>", keywords: "code pre monospace fence" },
  { id: "callout", label: "Callout", hint: "Highlighted note", icon: "!", keywords: "callout note highlight info" },
  { id: "divider", label: "Divider", hint: "Horizontal rule", icon: ", ", keywords: "divider rule separator hr" },
  { id: "duplicate", label: "Duplicate block", hint: "Copy this block below", icon: "⧉", keywords: "duplicate copy clone" },
  { id: "delete", label: "Delete block", hint: "Remove this block", icon: "⌫", keywords: "delete remove bin trash" },
];

const SAVE_DELAY = 320;
const COALESCE_MS = 900;

/* ----------------------------------------------------------------- state -- */

const state = {
  pages: [],
  activeId: null,
  doc: null,
  history: null,
  histories: new Map(),
  selectedId: null,
  slash: null,
  panel: null,
  search: "",
  dragId: null,
  drop: null,
  saveTimer: null,
  storage: null,
};

let storageBlocked = false;
let slashMenu = null;
const dom = {};

/* ---------------------------------------------------------------- helpers -- */

const activePage = () => state.pages.find((page) => page.id === state.activeId) || null;

function displayTitle(page) {
  return (page && page.title && page.title.trim()) || "Untitled";
}

function plural(count, one, many = `${one}s`) {
  return `${fmt.num(count)} ${count === 1 ? one : many}`;
}

function editableId(doc, preferred) {
  const rows = getRows(doc);
  if (!rows.length) return null;
  let start = preferred ? rows.findIndex((row) => row.block.id === preferred) : -1;
  if (start === -1) start = 0;
  for (let i = start; i < rows.length; i += 1) {
    if (rows[i].block.type !== "divider") return rows[i].block.id;
  }
  for (let i = start - 1; i >= 0; i -= 1) {
    if (rows[i].block.type !== "divider") return rows[i].block.id;
  }
  return null;
}

function rowForBlock(id) {
  return [...dom.editor.querySelectorAll(".block-row")].find((row) => row.dataset.id === id) || null;
}

function rowForSelection() {
  const selection = window.getSelection();
  if (!selection || !selection.anchorNode) return null;
  const node = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
  if (!node || !dom.editor.contains(node)) return null;
  return node.closest(".block-row");
}

function contentForRow(row) {
  return row ? row.querySelector(".block-content") : null;
}

function caretOffset(content) {
  if (!content) return null;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!content.contains(range.startContainer)) return null;
  const before = range.cloneRange();
  before.selectNodeContents(content);
  before.setEnd(range.startContainer, range.endOffset);
  return before.toString().length;
}

function setCaret(content, offset) {
  if (!content) return;
  const text = content.textContent || "";
  const target =
    offset === "end" || offset == null ? text.length : Math.max(0, Math.min(Number(offset), text.length));
  const range = document.createRange();
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();
  let remaining = target;

  while (textNode) {
    if (remaining <= textNode.nodeValue.length) {
      range.setStart(textNode, remaining);
      range.collapse(true);
      break;
    }
    remaining -= textNode.nodeValue.length;
    textNode = walker.nextNode();
  }
  if (!textNode) {
    range.selectNodeContents(content);
    range.collapse(false);
  }

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusBlock(id, caret = "end", options = {}) {
  const row = rowForBlock(id);
  if (!row) return false;
  const content = contentForRow(row);
  if (!content) return false;
  content.focus({ preventScroll: true });
  setCaret(content, caret === "end" ? content.textContent.length : caret);
  setSelected(id);
  if (options.scroll) content.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

function setSelected(id) {
  state.selectedId = id;
  updateActiveRow();
}

function updateActiveRow() {
  for (const row of dom.editor.querySelectorAll(".block-row")) {
    row.classList.toggle("is-active", row.dataset.id === state.selectedId);
  }
}

/* -------------------------------------------------------------- rendering -- */

function renderRow({ block, depth, marker }) {
  const row = document.createElement("div");
  row.className = "block-row";
  row.dataset.id = block.id;
  row.dataset.type = block.type;
  row.dataset.depth = String(depth);
  row.style.setProperty("--depth", String(depth));
  if (block.type === "todo") row.dataset.checked = block.checked ? "true" : "false";

  const gutter = document.createElement("div");
  gutter.className = "gutter";
  gutter.innerHTML =
    '<button class="gutter-add" type="button" data-add title="Insert block below" aria-label="Insert block below">+</button>' +
    '<button class="gutter-drag" type="button" data-drag draggable="true" title="Drag to move" aria-label="Drag to move"></button>';
  row.append(gutter);

  const main = document.createElement("div");
  main.className = "block-main";

  if (block.type === "divider") {
    const rule = document.createElement("hr");
    rule.className = "divider-line";
    main.append(rule);
    row.append(main);
    return row;
  }

  if (marker !== null && marker !== "") {
    const mark = document.createElement("span");
    mark.className = "marker";
    mark.textContent = marker;
    mark.setAttribute("aria-hidden", "true");
    main.append(mark);
  }

  if (block.type === "todo") {
    const box = document.createElement("button");
    box.type = "button";
    box.className = "todo-box";
    box.dataset.todo = block.id;
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", block.checked ? "true" : "false");
    box.setAttribute("aria-label", "Toggle to-do");
    main.append(box);
  }

  if (block.type === "callout") {
    const mark = document.createElement("span");
    mark.className = "callout-mark";
    mark.textContent = "i";
    mark.setAttribute("aria-hidden", "true");
    main.append(mark);
  }

  const content = document.createElement("div");
  content.className = "block-content";
  content.contentEditable = "true";
  content.spellcheck = false;
  content.dataset.blockId = block.id;
  content.setAttribute("aria-label", `${TYPE_LABELS[block.type] || "Text"} block`);
  content.textContent = block.text;

  if (!block.text) {
    content.dataset.empty = "true";
    content.dataset.placeholder = PLACEHOLDERS[block.type] || "";
  }

  main.append(content);
  row.append(main);
  return row;
}

function renderEditor(focus = null) {
  const fragment = document.createDocumentFragment();
  for (const row of getRows(state.doc)) fragment.append(renderRow(row));
  dom.editor.replaceChildren(fragment);

  if (!state.doc.blocks.length) {
    const empty = createBlock("paragraph", "");
    state.doc.blocks.push(empty);
    dom.editor.append(renderRow({ block: empty, depth: 0, marker: null }));
  }

  if (!state.doc.blocks.some((block) => block.id === state.selectedId)) {
    state.selectedId = editableId(state.doc, null);
  }
  updateActiveRow();

  if (focus) focusBlock(focus.id, focus.caret ?? "end", { scroll: focus.scroll });
}

function pageItem(page, titleMatched) {
  const stats = docStats(page.doc);
  const item = document.createElement("button");
  item.type = "button";
  item.className = "page-item";
  item.dataset.pageId = page.id;
  item.setAttribute("aria-current", page.id === state.activeId ? "true" : "false");
  if (page.id === state.activeId) item.classList.add("is-active");

  const title = document.createElement("span");
  title.className = "page-title-text";
  title.textContent = displayTitle(page);
  if (titleMatched) title.style.color = "var(--gold)";

  const meta = document.createElement("span");
  meta.className = "page-meta-text";
  const words = document.createElement("span");
  words.textContent = stats.words ? plural(stats.words, "word") : "Empty";
  const edited = document.createElement("span");
  edited.textContent = A.fmt.relative(page.updatedAt);
  meta.append(words, edited);

  item.append(title, meta);
  return item;
}

function renderPageList() {
  dom.pageList.replaceChildren();
  const query = state.search.trim();

  if (!query) {
    for (const page of state.pages) dom.pageList.append(pageItem(page, false));
    return;
  }

  const lower = query.toLowerCase();
  let results = 0;

  for (const page of state.pages) {
    const titleMatch = displayTitle(page).toLowerCase().includes(lower);
    const matches = searchBlocks(page.doc, query, { limit: 3 });
    if (!titleMatch && !matches.length) continue;

    dom.pageList.append(pageItem(page, titleMatch && !matches.length));
    results += 1;

    for (const match of matches.slice(0, 2)) {
      const hit = document.createElement("button");
      hit.type = "button";
      hit.className = "page-hit";
      hit.dataset.pageId = page.id;
      hit.dataset.blockId = match.blockId;
      hit.title = "Jump to match";
      const snippet = document.createElement("span");
      snippet.textContent = match.snippet;
      hit.append(snippet);
      dom.pageList.append(hit);
      results += 1;
    }
  }

  if (!results) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = `No page or block matches “${query}”.`;
    dom.pageList.append(empty);
  }
}

function updateStats() {
  const stats = docStats(state.doc);
  const page = activePage();

  dom.wordBadge.textContent = stats.words === 1 ? "1 word" : `${fmt.num(stats.words)} words`;
  dom.stats.textContent = `${plural(stats.words, "word")} · ${fmt.num(stats.characters)} characters · ${plural(
    stats.blocks,
    "block"
  )} · ${stats.readingMinutes ? `${stats.readingMinutes} min read` : "empty"}`;
  dom.blockCount.textContent = plural(stats.blocks, "block");
  if (page) {
    dom.pageMeta.textContent = `Edited ${A.fmt.relative(page.updatedAt)}`;
    document.title = `${displayTitle(page)}, Notewise`;
  }
}

function updateHistoryButtons() {
  const history = state.history;
  if (!history) return;
  dom.undo.disabled = !history.canUndo();
  dom.redo.disabled = !history.canRedo();
  dom.undo.title = history.canUndo() ? `Undo ${history.undoLabel()} (Ctrl+Z)` : "Nothing to undo";
  dom.redo.title = history.canRedo() ? `Redo ${history.redoLabel()} (Ctrl+Shift+Z)` : "Nothing to redo";
}

function setSaveState(mode, label = null) {
  const labels = { saved: "Saved", saving: "Saving…", error: "Session only" };
  dom.saveBadge.dataset.state = mode;
  dom.saveLabel.textContent = label || labels[mode] || "Saved";
}

function updateStorageNote() {
  if (!dom.storageNote) return;
  dom.storageNote.classList.toggle("is-warn", storageBlocked);
  dom.storageLabel.textContent = storageBlocked
    ? "Storage blocked, session only"
    : "Saved in this browser";
}

function refreshMarkdownPanel() {
  if (!state.panel) return;
  dom.panel.hidden = false;
  dom.openMarkdown.classList.toggle("is-active", state.panel === "export");
  dom.openImport.classList.toggle("is-active", state.panel === "import");
  setMdTab(state.panel);

  const markdown = toMarkdown(state.doc);
  dom.mdOutput.value = markdown;
  const page = activePage();
  dom.mdMeta.textContent = `${plural(docStats(state.doc).blocks, "block")} · ${
    markdown ? markdown.split("\n").length : 0
  } lines · ${fmt.num(markdown.length)} characters${page ? ` · ${slugify(displayTitle(page))}.md` : ""}`;
  dom.panelHint.textContent =
    toMarkdown(parseMarkdown(markdown)) === markdown ? "Round-trip: stable" : "Round-trip: differs";
}

function setMdTab(tab) {
  for (const button of $$("[data-md-tab]", dom.mdTabs)) {
    button.classList.toggle("active", button.dataset.mdTab === tab);
  }
  for (const section of $$("[data-md-panel]", dom.panel)) {
    section.hidden = section.dataset.mdPanel !== tab;
  }
}

function refreshChrome() {
  const page = activePage();
  if (!page) return;
  page.doc = state.doc;
  dom.crumb.textContent = displayTitle(page);
  dom.pageTitle.value = page.title || "";
  updateStats();
  updateHistoryButtons();
  renderPageList();
  if (state.panel) refreshMarkdownPanel();
}

/* ---------------------------------------------------------------- saving -- */

function scheduleSave() {
  setSaveState("saving");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

function saveNow() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  const page = activePage();
  if (page) page.doc = state.doc;
  const success = savePages(state.storage, { pages: state.pages, activeId: state.activeId });
  if (!success) storageBlocked = true;
  setSaveState(success ? "saved" : "error");
  updateStorageNote();
  return success;
}

function afterChange() {
  const page = activePage();
  if (page) {
    page.updatedAt = Date.now();
    page.doc = state.doc;
  }
  updateStats();
  updateHistoryButtons();
  renderPageList();
  updateStorageNote();
  scheduleSave();
  if (state.panel) refreshMarkdownPanel();
}

function commit({ label = "Edit", key = null, focus = null } = {}) {
  state.history.push(state.doc, { label, key });
  afterChange();
  renderEditor(focus);
  updateHistoryButtons();
}

/* ------------------------------------------------------------- page model -- */

function getHistory(page) {
  let history = state.histories.get(page.id);
  if (!history) {
    history = createHistory(page.doc, { coalesceMs: COALESCE_MS });
    state.histories.set(page.id, history);
  }
  return history;
}

function selectPage(id, options = {}) {
  const page = state.pages.find((item) => item.id === id) || state.pages[0];
  if (!page) return;
  if (!options.initial && state.history) saveNow();

  state.activeId = page.id;
  state.doc = page.doc;
  state.history = getHistory(page);
  state.selectedId = editableId(page.doc, null);
  closeSlash();

  dom.pageTitle.value = page.title || "";
  dom.crumb.textContent = displayTitle(page);
  dom.searchInput.value = state.search;

  renderEditor();
  refreshChrome();
  updateHistoryButtons();
  if (options.focusTitle) {
    dom.pageTitle.focus();
    dom.pageTitle.select();
  }
  if (options.scrollTop !== false) dom.stage.scrollTop = 0;
}

function newPage() {
  const page = createPage({ title: "", updatedAt: Date.now() });
  state.pages.unshift(page);
  selectPage(page.id, { focusTitle: true });
  scheduleSave();
  toast("New page created", "success", 1600);
}

/* -------------------------------------------------------------- caret ops -- */

function handleEnter(row, block, content) {
  const offset = caretOffset(content) ?? block.text.length;

  if (block.type === "code") {
    block.text = block.text.slice(0, offset) + "\n" + block.text.slice(offset);
    commit({ label: "New line", focus: { id: block.id, caret: offset + 1 } });
    return;
  }

  if (block.type === "divider") {
    const next = insertBlockAfter(state.doc, block.id, createBlock("paragraph", ""));
    commit({ label: "Insert block", focus: { id: next.id, caret: 0 } });
    return;
  }

  if (block.text === "" && ["bulleted", "numbered", "todo", "quote", "callout"].includes(block.type)) {
    setBlockType(state.doc, block.id, "paragraph");
    commit({ label: "Convert to text", focus: { id: block.id, caret: 0 } });
    return;
  }

  const result = splitBlock(state.doc, block.id, offset);
  if (!result) return;
  commit({ label: "Split block", focus: { id: result.block.id, caret: result.caret } });
}

function handleBackspace(row, block, content) {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;
  if ((caretOffset(content) ?? -1) !== 0) return false;

  const merged = mergeWithPrevious(state.doc, block.id);
  if (merged) {
    commit({ label: "Merge blocks", focus: { id: merged.block.id, caret: merged.caret } });
    return true;
  }

  if (dedentBlock(state.doc, block.id)) {
    commit({ label: "Outdent block", focus: { id: block.id, caret: 0 } });
    return true;
  }
  return false;
}

function handleTab(row, block, content, shiftKey) {
  const offset = caretOffset(content);
  const changed = shiftKey ? dedentBlock(state.doc, block.id) : indentBlock(state.doc, block.id);
  if (!changed) return;
  commit({
    label: shiftKey ? "Outdent block" : "Indent block",
    focus: { id: block.id, caret: offset ?? block.text.length },
  });
}

function insertBlockAfterCurrent() {
  const block = getBlock(state.doc, state.selectedId);
  const next = insertBlockAfter(state.doc, block ? block.id : null, createBlock("paragraph", ""));
  commit({ label: "Insert block", focus: { id: next.id, caret: 0 } });
  return next;
}

/* ---------------------------------------------------------------- history -- */

function undo() {
  const doc = state.history ? state.history.undo() : null;
  if (!doc) {
    toast("Nothing to undo", "info", 1400);
    return;
  }
  applyHistoryDoc(doc);
}

function redo() {
  const doc = state.history ? state.history.redo() : null;
  if (!doc) {
    toast("Nothing to redo", "info", 1400);
    return;
  }
  applyHistoryDoc(doc);
}

function applyHistoryDoc(doc) {
  state.doc = doc;
  const page = activePage();
  if (page) {
    page.doc = doc;
    page.updatedAt = Date.now();
  }
  const target = editableId(doc, state.selectedId);
  state.selectedId = target;
  renderEditor(target ? { id: target } : null);
  afterChange();
  updateHistoryButtons();
}

/* ------------------------------------------------------------- slash menu -- */

function filterCommands(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((command) => {
    const haystack = `${command.label} ${command.keywords}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function positionSlashMenu(anchor) {
  if (!slashMenu) return;
  const rect = (anchor || dom.editor).getBoundingClientRect();
  const width = slashMenu.offsetWidth || 336;
  const height = slashMenu.offsetHeight || 320;
  const left = Math.max(12, Math.min(Math.round(rect.left - 10), window.innerWidth - width - 12));
  let top = Math.round(rect.bottom + 8);
  if (top + height > window.innerHeight - 12) {
    top = Math.max(72, Math.round(rect.top - height - 8));
  }
  slashMenu.style.left = `${left}px`;
  slashMenu.style.top = `${top}px`;
}

function renderSlashMenu(anchor) {
  if (!state.slash || !slashMenu) return;
  const commands = filterCommands(state.slash.query);
  slashMenu.replaceChildren();

  const head = document.createElement("div");
  head.className = "slash-head";
  const headLabel = document.createElement("span");
  headLabel.textContent = state.slash.mode === "typed" ? "Commands" : "Insert block";
  const headQuery = document.createElement("span");
  headQuery.className = "slash-query";
  headQuery.textContent =
    state.slash.mode === "typed" ? `/${state.slash.query}` : plural(commands.length, "option");
  head.append(headLabel, headQuery);
  slashMenu.append(head);

  if (!commands.length) {
    const empty = document.createElement("div");
    empty.className = "slash-empty";
    empty.textContent = "No command matches. Backspace to edit the slash text.";
    slashMenu.append(empty);
  }

  commands.forEach((command, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `slash-option${index === state.slash.index ? " is-selected" : ""}`;
    option.dataset.command = command.id;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", index === state.slash.index ? "true" : "false");

    const icon = document.createElement("span");
    icon.className = "ico";
    icon.textContent = command.icon;

    const label = document.createElement("span");
    label.className = "label";
    const name = document.createElement("b");
    name.textContent = command.label;
    const hint = document.createElement("small");
    hint.textContent = command.hint;
    label.append(name, hint);

    const key = document.createElement("span");
    key.className = "key";
    key.textContent = "↵";

    option.append(icon, label, key);
    slashMenu.append(option);
  });

  const foot = document.createElement("div");
  foot.className = "slash-foot";
  foot.textContent = "↑↓ move · ↵ apply · esc dismiss";
  slashMenu.append(foot);

  slashMenu.hidden = false;
  positionSlashMenu(anchor);
  const selected = slashMenu.querySelector(".slash-option.is-selected");
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function closeSlash() {
  state.slash = null;
  if (slashMenu) slashMenu.hidden = true;
}

function openSlashFromGutter(blockId, row = null, content = null) {
  const block = getBlock(state.doc, blockId);
  if (!block || block.type === "divider") return;
  const targetRow = row || rowForBlock(blockId);
  const targetContent = content || contentForRow(targetRow);
  if (!targetRow || !targetContent) return;
  state.slash = { mode: "gutter", blockId, query: "", index: 0, start: block.text.length };
  targetContent.focus({ preventScroll: true });
  setCaret(targetContent, targetContent.textContent.length);
  renderSlashMenu(targetContent);
}

function syncSlashFromCaret() {
  if (!state.slash) return;
  if (state.slash.mode === "gutter") {
    // A printable key in a freshly inserted block means the writer changed
    // their mind; let the text be text.
    closeSlash();
    return;
  }

  const row = rowForSelection();
  if (!row) return closeSlash();
  const block = getBlock(state.doc, row.dataset.id);
  const content = contentForRow(row);
  if (!block || !content || block.type === "code" || block.type === "divider") return closeSlash();

  const caret = caretOffset(content);
  if (caret == null) return closeSlash();
  const before = block.text.slice(0, caret);
  const match = before.match(/(?:^|\s)\/([^/\n]{0,32})$/);
  if (!match) return closeSlash();

  const query = match[1];
  const previousIndex = state.slash.index;
  const sameBlock = state.slash.mode === "typed" && state.slash.blockId === block.id;
  state.slash = {
    mode: "typed",
    blockId: block.id,
    query,
    index: sameBlock ? previousIndex : 0,
    start: caret - query.length - 1,
  };
  const commands = filterCommands(query);
  if (!commands.length) state.slash.index = 0;
  else if (state.slash.index >= commands.length) state.slash.index = commands.length - 1;
  renderSlashMenu(content);
}

function slideSlash(delta) {
  if (!state.slash) return;
  const commands = filterCommands(state.slash.query);
  if (!commands.length) return;
  const content = contentForRow(rowForBlock(state.slash.blockId));
  state.slash.index = (state.slash.index + delta + commands.length) % commands.length;
  renderSlashMenu(content);
}

function runSlashCommand() {
  if (!state.slash) return;
  const slash = state.slash;
  const commands = filterCommands(slash.query);
  const command = commands[slash.index] || commands[0];
  if (!command) return;

  const block = getBlock(state.doc, slash.blockId);
  if (!block) {
    closeSlash();
    return;
  }

  const caret = slash.mode === "typed" ? slash.start : block.text.length;
  closeSlash();

  if (slash.mode === "typed" && block.text.slice(slash.start, slash.start + 1) === "/") {
    block.text = block.text.slice(0, slash.start) + block.text.slice(slash.start + slash.query.length + 1);
  }

  if (command.id === "duplicate") {
    const copy = duplicateBlock(state.doc, block.id);
    commit({
      label: "Duplicate block",
      focus: copy ? { id: copy.id, caret: "end" } : { id: block.id, caret: "end" },
    });
    return;
  }

  if (command.id === "delete") {
    const rows = getRows(state.doc);
    const index = rows.findIndex((row) => row.block.id === block.id);
    deleteBlock(state.doc, block.id);
    if (!state.doc.blocks.length) state.doc.blocks.push(createBlock("paragraph", ""));
    const neighbour = rows[index + 1] || rows[index - 1];
    commit({
      label: "Delete block",
      focus: { id: editableId(state.doc, neighbour ? neighbour.block.id : null), caret: "end" },
    });
    return;
  }

  setBlockType(state.doc, block.id, command.id);
  if (command.id === "divider") {
    const next = insertBlockAfter(state.doc, block.id, createBlock("paragraph", ""));
    commit({ label: `Insert ${command.label.toLowerCase()}`, focus: { id: next.id, caret: 0 } });
    return;
  }
  commit({ label: `Set ${command.label.toLowerCase()}`, focus: { id: block.id, caret } });
}

/* -------------------------------------------------------------- drag/drop -- */

function clearDropMarks() {
  for (const row of dom.editor.querySelectorAll(".block-row")) {
    row.classList.remove("drop-before", "drop-after");
  }
}

function clearDrag() {
  if (state.dragId) {
    const row = rowForBlock(state.dragId);
    if (row) row.classList.remove("is-dragging");
  }
  state.dragId = null;
  state.drop = null;
  clearDropMarks();
}

function onDragOver(event) {
  if (!state.dragId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const row = event.target.closest && event.target.closest(".block-row");
  if (!row || row.dataset.id === state.dragId) return;
  const rect = row.getBoundingClientRect();
  const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  state.drop = { targetId: row.dataset.id, position };
  clearDropMarks();
  row.classList.add(position === "before" ? "drop-before" : "drop-after");
}

function onDrop(event) {
  if (!state.dragId) return;
  event.preventDefault();
  const dragId = state.dragId;
  const drop = state.drop;
  clearDrag();
  if (!drop) return;
  if (!moveBlock(state.doc, dragId, drop.targetId, drop.position)) return;
  commit({ label: "Move block", focus: { id: dragId, caret: "end" } });
}

/* ----------------------------------------------------------- markdown panel -- */

function openPanel(tab = "export") {
  state.panel = tab;
  refreshMarkdownPanel();
  if (tab === "import") dom.mdInput.focus();
}

function closePanel() {
  state.panel = null;
  dom.panel.hidden = true;
  dom.openMarkdown.classList.remove("is-active");
  dom.openImport.classList.remove("is-active");
  if (/^#(markdown|import)$/.test(window.location.hash)) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

async function copyMarkdown() {
  const markdown = toMarkdown(state.doc);
  let copied = false;
  try {
    await navigator.clipboard.writeText(markdown);
    copied = true;
  } catch {
    dom.mdOutput.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    dom.mdOutput.setSelectionRange(0, 0);
  }
  toast(copied ? "Markdown copied" : "Could not copy, select the text instead", copied ? "success" : "error");
}

function downloadMarkdown() {
  const page = activePage();
  A.download(`${slugify(displayTitle(page))}.md`, toMarkdown(state.doc), "text/markdown;charset=utf-8");
  toast("Exported Markdown", "success", 1800);
}

function applyImport() {
  const source = dom.mdInput.value;
  if (!source.trim()) {
    toast("Paste Markdown or choose a file first", "error");
    return;
  }
  const parsed = parseMarkdown(source);
  if (!parsed.blocks.length) parsed.blocks.push(createBlock("paragraph", ""));

  const page = activePage();
  page.doc = parsed;
  page.updatedAt = Date.now();
  state.doc = parsed;
  state.histories.set(page.id, createHistory(parsed, { coalesceMs: COALESCE_MS }));
  state.history = state.histories.get(page.id);
  state.selectedId = editableId(parsed, null);

  renderEditor(state.selectedId ? { id: state.selectedId, caret: "end" } : null);
  afterChange();
  updateHistoryButtons();
  dom.mdInput.value = "";
  closePanel();
  toast(`Imported ${plural(countBlocks(parsed), "block")} from Markdown`, "success", 2400);
}

async function loadImportFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    dom.mdInput.value = text;
    setMdTab("import");
    toast(`Loaded ${file.name}`, "success", 1800);
  } catch {
    toast("Could not read that file", "error");
  }
}

/* ----------------------------------------------------------------- events -- */

function onInput(event) {
  const row = event.target.closest && event.target.closest(".block-row");
  if (!row) return;
  const block = getBlock(state.doc, row.dataset.id);
  const content = contentForRow(row);
  if (!block || !content) return;

  const raw = content.textContent || "";
  block.text = raw.replace(/\u00a0/g, " ");
  if (block.type !== "code") block.text = block.text.replace(/\s*\n\s*/g, " ");

  if (block.text) {
    delete content.dataset.empty;
    delete content.dataset.placeholder;
  } else {
    content.dataset.empty = "true";
    content.dataset.placeholder = PLACEHOLDERS[block.type] || "";
  }

  state.history.push(state.doc, { label: "Typing", key: `text:${block.id}` });
  setSelected(block.id);
  afterChange();
  syncSlashFromCaret();
}

function onKeyDown(event) {
  const target = event.target;
  const inTitle = target === dom.pageTitle;
  const inPanel = !!(target.closest && target.closest(".md-panel"));

  if (event.key === "Escape") {
    if (state.slash) {
      event.preventDefault();
      closeSlash();
      return;
    }
    if (state.panel) {
      event.preventDefault();
      closePanel();
      return;
    }
  }

  if (state.slash && !inTitle && !inPanel) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      slideSlash(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runSlashCommand();
      return;
    }
    if (event.key === "Tab") closeSlash();
  }

  const mod = event.metaKey || event.ctrlKey;
  if (mod && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      saveNow();
      toast("Saved to this browser", "success", 1500);
      return;
    }
    if (!inTitle && !inPanel && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (!inTitle && !inPanel && key === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (!inTitle && !inPanel && key === "e") {
      event.preventDefault();
      downloadMarkdown();
      return;
    }
  }

  if (inTitle || inPanel) return;

  const row = rowForSelection();
  if (!row) return;
  const block = getBlock(state.doc, row.dataset.id);
  const content = contentForRow(row);
  if (!block || !content) return;

  if (event.key === "Enter") {
    event.preventDefault();
    handleEnter(row, block, content);
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    handleTab(row, block, content, event.shiftKey);
    return;
  }

  if (event.key === "Backspace" && handleBackspace(row, block, content)) {
    event.preventDefault();
    return;
  }

  if (event.key === "ArrowUp") {
    const offset = caretOffset(content);
    if (offset === 0) {
      const contents = [...dom.editor.querySelectorAll(".block-content")];
      const index = contents.indexOf(content);
      if (index > 0) {
        event.preventDefault();
        focusBlock(contents[index - 1].dataset.blockId, "end");
      }
    }
    return;
  }

  if (event.key === "ArrowDown") {
    const offset = caretOffset(content);
    if (offset != null && offset >= content.textContent.length) {
      const contents = [...dom.editor.querySelectorAll(".block-content")];
      const index = contents.indexOf(content);
      if (index >= 0 && index < contents.length - 1) {
        event.preventDefault();
        focusBlock(contents[index + 1].dataset.blockId, 0);
      }
    }
  }
}

function onEditorClick(event) {
  const todo = event.target.closest("[data-todo]");
  if (todo) {
    event.preventDefault();
    const checked = toggleChecked(state.doc, todo.dataset.todo);
    if (checked == null) return;
    commit({
      label: checked ? "Check to-do" : "Uncheck to-do",
      focus: { id: todo.dataset.todo, caret: "end" },
    });
    return;
  }

  const add = event.target.closest("[data-add]");
  if (add) {
    event.preventDefault();
    const row = add.closest(".block-row");
    const block = row ? getBlock(state.doc, row.dataset.id) : null;
    if (!block) return;
    closeSlash();
    const next = insertBlockAfter(state.doc, block.id, createBlock("paragraph", ""));
    commit({ label: "Insert block", focus: { id: next.id, caret: 0 } });
    openSlashFromGutter(next.id);
    return;
  }

  const row = event.target.closest(".block-row");
  if (row) {
    if (state.slash && state.slash.blockId !== row.dataset.id) closeSlash();
    setSelected(row.dataset.id);
  }
}

function onEditorFocus(event) {
  const row = event.target.closest(".block-row");
  if (!row) return;
  if (state.slash && state.slash.blockId !== row.dataset.id) closeSlash();
  setSelected(row.dataset.id);
}

function onPaste(event) {
  const row = event.target.closest && event.target.closest(".block-row");
  if (!row) return;
  const block = getBlock(state.doc, row.dataset.id);
  const content = contentForRow(row);
  if (!block || !content) return;

  const data = event.clipboardData || window.clipboardData;
  const text = data ? data.getData("text/plain") : "";
  if (!text) return;
  event.preventDefault();

  const offset = caretOffset(content) ?? content.textContent.length;
  const clean =
    block.type === "code" ? text.replace(/\r\n?/g, "\n") : text.replace(/\r\n?/g, "\n").replace(/\s*\n\s*/g, " ");
  block.text = block.text.slice(0, offset) + clean + block.text.slice(offset);
  commit({ label: "Paste text", focus: { id: block.id, caret: offset + clean.length } });
}

function bindEvents() {
  dom.editor.addEventListener("input", onInput);
  dom.editor.addEventListener("click", onEditorClick);
  dom.editor.addEventListener("focusin", onEditorFocus);
  dom.editor.addEventListener("paste", onPaste);

  dom.editor.addEventListener("dragstart", (event) => {
    const handle = event.target.closest && event.target.closest("[data-drag]");
    if (!handle) {
      event.preventDefault();
      return;
    }
    const row = handle.closest(".block-row");
    if (!row) return;
    state.dragId = row.dataset.id;
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.id);
    }
    closeSlash();
  });
  dom.editor.addEventListener("dragend", clearDrag);
  dom.editor.addEventListener("dragover", onDragOver);
  dom.editor.addEventListener("drop", onDrop);

  dom.stage.addEventListener("scroll", () => {
    if (state.slash) closeSlash();
  });
  window.addEventListener("resize", () => {
    if (state.slash) closeSlash();
  });

  dom.undo.addEventListener("click", undo);
  dom.redo.addEventListener("click", redo);
  dom.newPage.addEventListener("click", newPage);

  dom.pageTitle.addEventListener("input", () => {
    const page = activePage();
    if (!page) return;
    page.title = dom.pageTitle.value;
    page.updatedAt = Date.now();
    page.doc = state.doc;
    dom.crumb.textContent = displayTitle(page);
    document.title = `${displayTitle(page)}, Notewise`;
    renderPageList();
    scheduleSave();
    if (state.panel) refreshMarkdownPanel();
  });

  dom.pageTitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const first = editableId(state.doc, null);
      if (first) focusBlock(first, 0);
    }
  });

  dom.searchInput.addEventListener("input", () => {
    state.search = dom.searchInput.value;
    renderPageList();
  });

  dom.pageList.addEventListener("click", (event) => {
    const hit = event.target.closest(".page-hit");
    if (hit) {
      selectPage(hit.dataset.pageId);
      focusBlock(hit.dataset.blockId, "end", { scroll: true });
      state.search = "";
      dom.searchInput.value = "";
      renderPageList();
      return;
    }
    const item = event.target.closest(".page-item");
    if (item) selectPage(item.dataset.pageId);
  });

  dom.openMarkdown.addEventListener("click", () => openPanel("export"));
  dom.openImport.addEventListener("click", () => openPanel("import"));
  dom.closePanel.addEventListener("click", closePanel);

  dom.mdTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-md-tab]");
    if (!button) return;
    state.panel = button.dataset.mdTab;
    setMdTab(state.panel);
    if (state.panel === "export") refreshMarkdownPanel();
  });

  dom.exportButton.addEventListener("click", downloadMarkdown);
  dom.copyButton.addEventListener("click", copyMarkdown);
  dom.downloadButton.addEventListener("click", downloadMarkdown);
  dom.applyButton.addEventListener("click", applyImport);
  dom.pickButton.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => {
    const file = dom.fileInput.files && dom.fileInput.files[0];
    loadImportFile(file);
    dom.fileInput.value = "";
  });

  slashMenu = $("#slash-menu");
  slashMenu.addEventListener("mousedown", (event) => event.preventDefault());
  slashMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-command]");
    if (!option || !state.slash) return;
    const commands = filterCommands(state.slash.query);
    const index = commands.findIndex((command) => command.id === option.dataset.command);
    if (index === -1) return;
    state.slash.index = index;
    runSlashCommand();
  });

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("click", (event) => {
    if (!state.slash) return;
    if (slashMenu.contains(event.target) || dom.editor.contains(event.target)) return;
    closeSlash();
  });

  window.addEventListener("hashchange", () => {
    const hash = window.location.hash;
    if (hash === "#markdown") openPanel("export");
    else if (hash === "#import") openPanel("import");
  });

  window.addEventListener("beforeunload", () => {
    if (state.saveTimer) saveNow();
  });
}

/* --------------------------------------------------------- automation hook -- */

async function typeText(text, delay = 16) {
  for (const character of Array.from(text)) {
    const row = rowForSelection() || rowForBlock(state.selectedId);
    if (!row) return false;
    const content = contentForRow(row);
    if (!content) return false;
    content.focus({ preventScroll: true });
    setCaret(content, content.textContent.length);

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, character);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      const block = getBlock(state.doc, row.dataset.id);
      if (!block) return false;
      block.text += character;
      content.textContent = block.text;
      content.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return true;
}

function installAutomationAPI() {
  window.notewise = {
    state: () => ({
      activeId: state.activeId,
      pages: state.pages.map((page) => ({
        id: page.id,
        title: page.title,
        words: docStats(page.doc).words,
        blocks: docStats(page.doc).blocks,
      })),
      words: docStats(state.doc).words,
      panel: state.panel,
    }),
    selectPage,
    newPage,
    focusBlockByIndex(index = 0) {
      const rows = getRows(state.doc);
      const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
      if (row) focusBlock(row.block.id, "end");
      return row ? row.block.id : null;
    },
    focusBlock(id) {
      return focusBlock(id, "end");
    },
    addBlock() {
      return insertBlockAfterCurrent().id;
    },
    openSlash() {
      const row = rowForSelection() || rowForBlock(state.selectedId);
      if (!row) return false;
      openSlashFromGutter(row.dataset.id, row);
      return true;
    },
    type: (text, delay = 16) => typeText(text, delay),
    undo,
    redo,
    openPanel,
    closePanel,
    markdown: () => toMarkdown(state.doc),
  };
}

/* -------------------------------------------------------------------- init -- */

function probeStorage() {
  try {
    const probe = "__notewise_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

function cacheDom() {
  dom.editor = $("#editor");
  dom.stage = $(".editor-stage");
  dom.sheet = $("#sheet");
  dom.pageList = $("#page-list");
  dom.pageTitle = $("#page-title");
  dom.pageMeta = $("#page-meta");
  dom.blockCount = $("#page-block-count");
  dom.crumb = $("#crumb-page");
  dom.undo = $("#undo");
  dom.redo = $("#redo");
  dom.newPage = $("#new-page");
  dom.searchInput = $("#page-search");
  dom.wordBadge = $("#word-badge");
  dom.stats = $("#stats");
  dom.saveBadge = $("#save-state");
  dom.saveLabel = $("#save-label");
  dom.storageNote = $("#storage-note");
  dom.storageLabel = $("#storage-label");
  dom.openMarkdown = $("#open-markdown");
  dom.openImport = $("#open-import");
  dom.exportButton = $("#export-md");
  dom.panel = $("#markdown-panel");
  dom.mdTabs = $("#md-tabs");
  dom.mdOutput = $("#md-output");
  dom.mdInput = $("#md-input");
  dom.mdMeta = $("#md-meta");
  dom.panelHint = $("#panel-hint");
  dom.copyButton = $("#copy-md");
  dom.downloadButton = $("#download-md");
  dom.pickButton = $("#pick-md");
  dom.applyButton = $("#apply-md");
  dom.fileInput = $("#md-file");
  dom.closePanel = $("#close-panel");
}

function routeFromHash() {
  const hash = window.location.hash;
  if (hash === "#markdown") openPanel("export");
  else if (hash === "#import") openPanel("import");
}

function init() {
  cacheDom();
  state.storage = probeStorage();
  storageBlocked = !state.storage;

  const loaded = loadPages(state.storage, seedPages);
  state.pages = loaded.pages;
  state.activeId = loaded.activeId;

  bindEvents();
  selectPage(state.activeId, { initial: true });
  updateStorageNote();
  setSaveState(storageBlocked ? "error" : "saved");
  routeFromHash();
  installAutomationAPI();

  if (!loaded.restored && state.pages.length) scheduleSave();
}

init();
