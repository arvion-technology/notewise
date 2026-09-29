import test from "node:test";
import assert from "node:assert/strict";

import { createHistory } from "../src/history.js";
import { createBlock, createDoc } from "../src/blocks.js";

const doc = (text) => createDoc([createBlock("paragraph", text, { id: "b1" })]);

function clocked(options = {}) {
  let time = 0;
  const history = createHistory(doc(""), { coalesceMs: 800, now: () => time, ...options });
  return {
    history,
    advance: (ms) => { time += ms; },
    now: () => time,
  };
}

test("push, undo and redo move through document snapshots", () => {
  const { history } = clocked();
  history.push(doc("one"), { label: "Typed one" });
  history.push(doc("two"), { label: "Typed two" });
  assert.equal(history.size(), 3);
  assert.equal(history.canUndo(), true);
  assert.equal(history.undo().blocks[0].text, "one");
  assert.equal(history.undo().blocks[0].text, "", "returns to the opened state");
  assert.equal(history.undo(), null);
  assert.equal(history.canRedo(), true);
  assert.equal(history.redo().blocks[0].text, "one");
  assert.equal(history.redo().blocks[0].text, "two");
  assert.equal(history.redo(), null);
});

test("snapshots are independent of the live document", () => {
  const { history } = clocked();
  const live = doc("first");
  history.push(live, { label: "Edit" });
  live.blocks[0].text = "mutated after push";
  assert.equal(history.undo().blocks[0].text, "");
  assert.equal(history.redo().blocks[0].text, "first");
});

test("typing with the same key inside the window coalesces into one step", () => {
  const { history, advance } = clocked();
  advance(10);
  history.push(doc("h"), { key: "text:b1", label: "Typing" });
  advance(100);
  history.push(doc("he"), { key: "text:b1", label: "Typing" });
  advance(100);
  history.push(doc("hel"), { key: "text:b1", label: "Typing" });
  assert.equal(history.size(), 2, "initial + one coalesced typing step");
  assert.equal(history.undo().blocks[0].text, "");
  assert.equal(history.redo().blocks[0].text, "hel");
});

test("a pause longer than the window starts a new undo step", () => {
  const { history, advance } = clocked();
  history.push(doc("h"), { key: "text:b1" });
  advance(900);
  history.push(doc("he"), { key: "text:b1" });
  assert.equal(history.size(), 3);
  assert.equal(history.undo().blocks[0].text, "h");
  assert.equal(history.undo().blocks[0].text, "");
});

test("a different key breaks coalescence", () => {
  const { history, advance } = clocked();
  history.push(doc("h"), { key: "text:b1" });
  advance(50);
  history.push(doc("heading"), { key: "type:b1", label: "Convert to heading" });
  assert.equal(history.size(), 3);
});

test("structural edits without a key never coalesce", () => {
  const { history, advance } = clocked();
  history.push(doc("a"), { label: "Split block" });
  advance(20);
  history.push(doc("ab"), { label: "Split block" });
  assert.equal(history.size(), 3);
});

test("breakCoalesce forces the next keystroke into a new step", () => {
  const { history, advance } = clocked();
  history.push(doc("h"), { key: "text:b1" });
  advance(50);
  history.breakCoalesce();
  advance(20);
  history.push(doc("he"), { key: "text:b1" });
  assert.equal(history.size(), 3);
});

test("pushing after undo drops the redo branch", () => {
  const { history } = clocked();
  history.push(doc("one"), { label: "One" });
  history.push(doc("two"), { label: "Two" });
  history.undo();
  assert.equal(history.canRedo(), true);
  history.push(doc("branch"), { label: "Branch" });
  assert.equal(history.canRedo(), false);
  assert.equal(history.size(), 3);
});

test("identical snapshots are ignored", () => {
  const { history } = clocked();
  assert.equal(history.push(doc(""), { label: "No-op" }), false);
  history.push(doc("one"), { label: "One" });
  assert.equal(history.push(doc("one"), { label: "Duplicate" }), false);
  assert.equal(history.size(), 2);
});

test("the limit trims the oldest entries", () => {
  const { history } = clocked({ limit: 2 });
  history.push(doc("one"), { label: "One" });
  history.push(doc("two"), { label: "Two" });
  history.push(doc("three"), { label: "Three" });
  assert.equal(history.size(), 3);
  assert.equal(history.undo().blocks[0].text, "two");
  assert.equal(history.undo().blocks[0].text, "one");
  assert.equal(history.undo(), null);
});

test("labels describe the step undo and redo would act on", () => {
  const { history } = clocked();
  history.push(doc("one"), { label: "Type one", key: "text:b1" });
  assert.equal(history.undoLabel(), "Type one");
  assert.equal(history.redoLabel(), null);
  history.undo();
  assert.equal(history.undoLabel(), null);
  assert.equal(history.redoLabel(), "Type one");
});

test("reset replaces the stack with a fresh baseline", () => {
  const { history } = clocked();
  history.push(doc("one"), { label: "One" });
  history.reset(doc("imported"), "Imported");
  assert.equal(history.size(), 1);
  assert.equal(history.canUndo(), false);
  history.push(doc("edited"), { label: "Edit" });
  assert.equal(history.undo().blocks[0].text, "imported");
});
