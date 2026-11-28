// Preview-mode smoke tests for the manager page.
//
// The manager page is also served on the open web (GitHub Pages), where the
// extension APIs do not exist. These tests load manager.js in a vm with NO
// `chrome` global and a minimal DOM stub, and assert that preview mode
// engages instead of hanging on "Checking…" forever (the bug found by the
// 2026-11-25 visual review), that sample sessions render, and that every
// action needing the extension is disabled. No jsdom, no dependencies —
// plain Node.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

function makeElement(id) {
  const el = {
    id,
    hidden: false,
    disabled: false,
    textContent: "",
    title: "",
    value: "",
    className: "",
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    children: [],
    appendChild(child) { el.children.push(child); return child; },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; },
    showModal() {},
    close() {},
    focus() {},
    click() {},
  };
  // innerHTML = "" clears the element, as in a real browser; the
  // preview boot renders the list twice (list, then first sample).
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return html; },
    set(v) { html = v; if (v === "") el.children = []; },
  });
  return el;
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

test("preview mode: sample sessions render (3) and are labelled as samples", () => {
  const el = loadManager();
  assert.equal(el.get("sample-banner").hidden, false, "sample banner must be visible");
  assert.equal(el.get("session-list").children.length, 3, "three sample sessions listed");
  assert.match(el.get("counts").textContent, /3 session/);
});

test("preview mode: restore / rename / delete / export actions are disabled", () => {
  const el = loadManager();
  for (const id of ["restore-btn", "rename-btn", "delete-btn", "export-btn",
    "export-text-btn", "trash-restore-btn", "trash-delete-btn", "empty-trash-btn"]) {
    assert.equal(el.get(id).disabled, true, id + " must be disabled in preview mode");
  }
});

test("banner buttons keep their primary background (no white-on-white)", () => {
  const css = readFileSync(new URL("../manager/styles.css", import.meta.url), "utf-8");
  assert.match(css, /\.banner button:not\(\.primary\)/);
  assert.doesNotMatch(css, /\.banner button \{ background/);
});

test("hidden elements are actually hidden (flex rules must not override [hidden])", () => {
  // v2 screenshot review: .banner and .restore-bar set display:flex,
  // which beats the browser's built-in [hidden] rule — so the recovery
  // banner, the empty integrity alert and the trash bar all showed
  // even when hidden. The stylesheet must force [hidden] off.
  const css = readFileSync(new URL("../manager/styles.css", import.meta.url), "utf-8");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("Recently closed tab label does not wrap", () => {
  const css = readFileSync(new URL("../manager/styles.css", import.meta.url), "utf-8");
  const block = /\.list-tab \{[^}]*\}/.exec(css);
  assert.ok(block, ".list-tab rule exists");
  assert.match(block[0], /white-space:\s*nowrap/);
});

test("dialogs: Enter submits the confirm action, Cancel never does", () => {
  // The v1 bug: Cancel was the first submit button in each dialog, so
  // pressing Enter in the rename field cancelled instead of saving.
  // Cancel buttons must be type="button"; confirms type="submit".
  const html = readFileSync(new URL("../manager/index.html", import.meta.url), "utf-8");
  for (const id of ["restore-cancel", "rename-cancel", "import-cancel"]) {
    const m = new RegExp('<button[^>]*id="' + id + '"[^>]*>').exec(html);
    assert.ok(m, id + " exists");
    assert.match(m[0], /type="button"/, id + " must be type=button");
  }
  for (const id of ["restore-confirm", "rename-confirm", "import-confirm"]) {
    const m = new RegExp('<button[^>]*id="' + id + '"[^>]*>').exec(html);
    assert.ok(m, id + " exists");
    assert.match(m[0], /type="submit"/, id + " must be type=submit");
  }
  // And Cancel must come before Confirm in DOM order is now harmless:
  // implicit submission picks the first SUBMIT button, which is Confirm.
});

test("manager HTML: sort control and tag filter exist", () => {
  const html = readFileSync(new URL("../manager/index.html", import.meta.url), "utf-8");
  assert.match(html, /id="sort"/);
  assert.match(html, /value="newest"/);
  assert.match(html, /value="oldest"/);
  assert.match(html, /value="name"/);
  assert.match(html, /value="tabs"/);
  assert.match(html, /id="tag-filter"/);
  assert.match(html, /id="trash-bar"/);
  assert.match(html, /id="empty-trash-btn"/);
  assert.match(html, /id="restore-selected-btn"/);
  assert.match(html, /id="export-text-btn"/);
});
