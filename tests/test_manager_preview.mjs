// Preview-mode smoke test for the manager page.
//
// The manager page is also served on the open web (GitHub Pages), where the
// extension APIs do not exist. This test loads manager.js in a vm with NO
// `chrome` global and a minimal DOM stub, and asserts that preview mode
// engages instead of hanging on "Checking…" forever (the bug found by the
// 2026-11-25 visual review). No jsdom, no dependencies — plain Node.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

function makeElement(id) {
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: "",
    title: "",
    value: "",
    className: "",
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    addEventListener() {},
    removeEventListener() {},
    showModal() {},
    close() {},
    focus() {},
    click() {},
  };
}

function loadManager() {
  const elements = new Map();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
      },
      addEventListener() {},
      activeElement: null,
      createElement() { return makeElement("created"); },
      body: { appendChild() {} },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  // Deliberately NO `chrome` global: this is a plain web page.
  vm.createContext(sandbox);
  for (const lib of ["../lib/sessionstore.js", "../lib/idb.js", "../lib/backup.js"]) {
    vm.runInContext(readFileSync(new URL(lib, import.meta.url), "utf-8"), sandbox, { filename: lib });
  }
  vm.runInContext(readFileSync(new URL("../manager/manager.js", import.meta.url), "utf-8"), sandbox, { filename: "manager.js" });
  return elements;
}

test("preview mode: notice shown, badge resolves to Preview, extension actions disabled", () => {
  const el = loadManager();
  assert.equal(el.get("preview-banner").hidden, false, "preview banner must be visible");
  assert.equal(el.get("integrity-badge").textContent, "Preview");
  for (const id of ["save-window", "save-all", "empty-save", "export-all-btn", "import-btn"]) {
    assert.equal(el.get(id).disabled, true, id + " must be disabled in preview mode");
  }
  assert.match(el.get("status").textContent, /Preview/);
});

test("banner buttons keep their primary background (no white-on-white)", () => {
  const css = readFileSync(new URL("../manager/styles.css", import.meta.url), "utf-8");
  assert.match(css, /\.banner button:not\(\.primary\)/);
  assert.doesNotMatch(css, /\.banner button \{ background/);
});

test("Recently closed tab label does not wrap", () => {
  const css = readFileSync(new URL("../manager/styles.css", import.meta.url), "utf-8");
  const block = /\.list-tab \{[^}]*\}/.exec(css);
  assert.ok(block, ".list-tab rule exists");
  assert.match(block[0], /white-space:\s*nowrap/);
});
