/**
 * Seeded pages. The ids are fixed so deep links, screenshots and the
 * recording script can address a page without first reading localStorage.
 */

import { createBlock } from "../src/blocks.js";
import { createPage } from "../src/storage.js";

const p = (text, children = []) => createBlock("paragraph", text, { children });
const h2 = (text) => createBlock("heading2", text);
const h3 = (text) => createBlock("heading3", text);
const bullet = (text, children = []) => createBlock("bulleted", text, { children });
const number = (text) => createBlock("numbered", text);
const todo = (text, checked = false) => createBlock("todo", text, { checked });
const quote = (text) => createBlock("quote", text);
const code = (text, lang = "") => createBlock("code", text, { lang });
const callout = (text) => createBlock("callout", text);
const divider = () => createBlock("divider", "");

function welcomePage() {
  return createPage({
    id: "p-welcome",
    title: "Welcome to Notewise",
    updatedAt: Date.now() - 1000 * 60 * 4,
    blocks: [
      p(
        "Notewise is a block editor that keeps the document in a tree and the writing on paper. Every row below is a block: press Enter to split one, Backspace at the start to merge it into the line above, or drag the handle in the left gutter to move it."
      ),
      callout(
        "Edits are saved to this browser's localStorage a few hundred milliseconds after you stop typing. Nothing is sent anywhere."
      ),
      h2("Things worth trying"),
      bullet("Type / at the start of a line to open the command menu, then use the arrow keys and Enter.", [
        bullet("Text, headings, lists, to-dos, quotes, code, callouts and dividers are all block types."),
        bullet("Escape leaves the slash as ordinary text if you change your mind."),
      ]),
      bullet("Tab nests a block under the one above it. Shift-Tab lifts it back out and takes its followers with it."),
      bullet("Hover the left gutter and drag a block by its handle to reorder it, subtree included."),
      todo("Press Ctrl+Z after a burst of typing, the whole burst is one undo step", true),
      h2("Why a tree"),
      p(
        "A flat contenteditable region is easy to start with and painful to maintain: nesting lives in the HTML, list numbers live in the browser, and every operation has to reverse-engineer the DOM. Here the DOM is a projection of page.doc. Insert, split, merge, indent and move are functions in src/blocks.js with tests, and the view is rebuilt after each structural edit."
      ),
      quote("The editor is a tree. The page is only a view of it."),
      h2("Markdown in and out"),
      p(
        "The Markdown panel serializes the same tree the tests exercise. Export writes headings, nested lists, to-dos, quotes, callouts, fenced code and dividers; import runs the parser and replaces the page."
      ),
      code(
        'import { splitBlock } from "../src/blocks.js";\n\n// Split at the caret; the children stay with the tail\nconst { block, caret } = splitBlock(doc, "b-7", 12);',
        "js"
      ),
      divider(),
      p(
        "That is the whole editor: a small tree, a parser, an undo stack and a page that saves itself. The README lists what it deliberately leaves out."
      ),
    ],
  });
}

function fieldNotesPage() {
  return createPage({
    id: "p-field-notes",
    title: "Field notes, Patan, Tuesday",
    updatedAt: Date.now() - 1000 * 60 * 60 * 26,
    blocks: [
      p(
        "The lane behind the temple was quiet at seven. A woman swept the step of a shop that sold brass lamps, and the only other sound was a radio somewhere above the courtyard."
      ),
      h2("Three things to remember"),
      bullet("The man at the tea stall counts change in his head, then checks it twice.", [
        bullet("He asked where I was from, then laughed at the answer, as if Kathmandu were next door."),
      ]),
      bullet("The bronze workshop opens at nine, not eight. The sign is wrong and nobody fixes it."),
      bullet("Rain arrives at four, almost on schedule, and the lane empties in ten minutes."),
      quote("Write it down before it turns into a story."),
      todo("Ask about the casting process at the workshop"),
      p("I want to come back with a recorder and no plan."),
    ],
  });
}

function releaseChecklistPage() {
  return createPage({
    id: "p-release",
    title: "Release checklist",
    updatedAt: Date.now() - 1000 * 60 * 60 * 3,
    blocks: [
      p("A short list for publishing a page built with Notewise. The point is to make the handoff boring."),
      h2("Before export"),
      todo("Read the page out loud once", true),
      todo("Check that every nested list has a parent that makes sense", true),
      todo("Export the Markdown and reopen it in another editor"),
      todo("Keep the exported .md next to the project files"),
      h2("Known gaps"),
      bullet("Inline emphasis is still literal Markdown, not rich text"),
      bullet("No collaborative editing; the page lives in one browser"),
      number("Open the Markdown panel"),
      number("Read the export like a stranger would"),
      divider(),
      p("If a page survives a Markdown round-trip and still reads well, it is ready to leave the editor."),
    ],
  });
}

export function seedPages() {
  const pages = [welcomePage(), fieldNotesPage(), releaseChecklistPage()];
  return { pages, activeId: "p-welcome" };
}
