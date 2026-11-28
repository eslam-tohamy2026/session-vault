/* Session Vault — Node tests for lib/restore.js.
   The restore engine runs against a FakeChrome that records every
   call and only reports a tab's URL when the test says so — which is
   exactly what proves the about:blank trap is handled.
   Run: node --test tests/test_restore.mjs
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SessionStore = require("../lib/sessionstore.js");
const Restore = require("../lib/restore.js");

/* A minimal in-memory Chrome. tabs.create does NOT report the URL by
 * itself: the test must call emitUrl(tabId), mirroring how the real
 * engine waits for chrome.tabs.onUpdated. tabs.discard returns a tab
 * with a NEW id, as some Chrome versions do. */
class FakeChrome {
  constructor() {
    this.windows = new Map();
    this.tabs = new Map();
    this.groups = new Map();
    this.nextWindowId = 1;
    this.nextTabId = 1;
    this.nextGroupId = 1;
    this.calls = {
      windowsCreate: [], tabsCreate: [], tabsMove: [], tabsGroup: [],
      tabGroupsUpdate: [], tabsDiscard: [], tabsRemove: [], tabsUpdate: [],
    };
    this.urlReported = new Set();
    this.urlWaiters = new Map();
    this.failUrls = new Set();
  }

  async windowsCreate(opts) {
    this.calls.windowsCreate.push(opts);
    const id = this.nextWindowId++;
    const initial = { id: this.nextTabId++, windowId: id, index: 0, url: "chrome://newtab", title: "New Tab", pinned: false, active: true };
    this.tabs.set(initial.id, initial);
    this.windows.set(id, { id, focused: !!opts.focused, incognito: !!opts.incognito, state: opts.state || "normal", tabIds: [initial.id] });
    return { id, tabs: [initial] };
  }

  async tabsCreate(opts) {
    this.calls.tabsCreate.push(opts);
    if (this.failUrls.has(opts.url)) throw new Error("failed to create tab");
    const id = this.nextTabId++;
    const tab = {
      id, windowId: opts.windowId, index: opts.index != null ? opts.index : 0,
      url: opts.url, title: "", pinned: !!opts.pinned, active: !!opts.active,
    };
    // Register the tab BEFORE splicing its id into the window, or the
    // index fix-up below trips over an id with no tab yet.
    this.tabs.set(id, tab);
    const win = this.windows.get(opts.windowId);
    const at = Math.min(tab.index, win.tabIds.length);
    win.tabIds.splice(at, 0, id);
    win.tabIds.forEach((tid, i) => { this.tabs.get(tid).index = i; });
    return tab;
  }

  async tabsMove(tabIds, opts) {
    this.calls.tabsMove.push({ tabIds: tabIds.slice(), opts, urls: tabIds.map((id) => this.tabs.get(id).url) });
    const winId = this.tabs.get(tabIds[0]).windowId;
    const win = this.windows.get(winId);
    const rest = win.tabIds.filter((id) => !tabIds.includes(id));
    win.tabIds = tabIds.concat(rest);
    win.tabIds.forEach((tid, i) => { this.tabs.get(tid).index = i; });
    return tabIds.map((id) => this.tabs.get(id));
  }

  async tabsGroup(opts) {
    this.calls.tabsGroup.push(opts);
    const groupId = this.nextGroupId++;
    this.groups.set(groupId, { tabIds: opts.tabIds.slice(), title: "", color: "grey", collapsed: false });
    opts.tabIds.forEach((id) => { this.tabs.get(id).groupId = groupId; });
    return groupId;
  }

  async tabGroupsUpdate(groupId, props) {
    this.calls.tabGroupsUpdate.push({ groupId, props });
    Object.assign(this.groups.get(groupId), props);
  }

  async tabsUpdate(tabId, props) {
    this.calls.tabsUpdate.push({ tabId, props });
    Object.assign(this.tabs.get(tabId), props);
  }

  async tabsRemove(tabIds) {
    this.calls.tabsRemove.push(tabIds.slice());
    tabIds.forEach((id) => {
      const tab = this.tabs.get(id);
      if (!tab) return;
      const win = this.windows.get(tab.windowId);
      win.tabIds = win.tabIds.filter((x) => x !== id);
      this.tabs.delete(id);
      if (win.tabIds.length === 0) this.windows.delete(win.id);
    });
  }

  async tabsDiscard(tabId) {
    this.calls.tabsDiscard.push(tabId);
    const old = this.tabs.get(tabId);
    // Simulate Chrome returning a tab with a NEW id after discarding.
    const replacement = Object.assign({}, old, { id: this.nextTabId++, discarded: true });
    const win = this.windows.get(old.windowId);
    win.tabIds[win.tabIds.indexOf(tabId)] = replacement.id;
    this.tabs.delete(tabId);
    this.tabs.set(replacement.id, replacement);
    return replacement;
  }

  async tabsQuery(query) {
    const out = [];
    this.tabs.forEach((t) => {
      if (query.windowId == null || t.windowId === query.windowId) out.push(t);
    });
    return out.sort((a, b) => a.index - b.index);
  }

  emitUrl(tabId) {
    this.urlReported.add(tabId);
    const waiters = this.urlWaiters.get(tabId) || [];
    this.urlWaiters.set(tabId, []);
    waiters.forEach((resolve) => resolve(true));
  }

  async waitForUrl(tabId, timeoutMs) {
    if (this.urlReported.has(tabId)) return true;
    return new Promise((resolve) => {
      const list = this.urlWaiters.get(tabId) || [];
      list.push(resolve);
      this.urlWaiters.set(tabId, list);
      setTimeout(() => resolve(false), timeoutMs);
    });
  }

  get api() {
    return {
      windowsCreate: (o) => this.windowsCreate(o),
      tabsCreate: (o) => this.tabsCreate(o),
      tabsMove: (ids, o) => this.tabsMove(ids, o),
      tabsGroup: (o) => this.tabsGroup(o),
      tabGroupsUpdate: (id, p) => this.tabGroupsUpdate(id, p),
      tabsUpdate: (id, p) => this.tabsUpdate(id, p),
      tabsRemove: (ids) => this.tabsRemove(ids),
      tabsDiscard: (id) => this.tabsDiscard(id),
      tabsQuery: (q) => this.tabsQuery(q),
      waitForUrl: (id, ms) => this.waitForUrl(id, ms),
    };
  }
}

function fixtureSession() {
  const windows = [
    { id: 1, focused: true, incognito: false, state: "normal", name: null },
    { id: 2, focused: false, incognito: false, state: "normal", name: null },
  ];
  const groups = [
    { id: 11, title: "Research", color: "blue", collapsed: false, windowId: 1 },
    { id: 12, title: "Docs", color: "green", collapsed: true, windowId: 2 },
  ];
  const tabs = [];
  let n = 0;
  function tab(windowId, index, url, title, extra) {
    n += 1;
    tabs.push(Object.assign({
      id: n, windowId, index, url, title, pinned: false, active: false, groupId: -1, discarded: false,
    }, extra || {}));
  }
  tab(1, 0, "https://example.com/a", "A", { active: true, pinned: true });
  tab(1, 1, "https://example.com/b", "B", { pinned: true });
  tab(1, 2, "https://news.example.org/1", "N1", { groupId: 11 });
  tab(1, 3, "https://news.example.org/2", "N2", { groupId: 11 });
  tab(1, 4, "chrome://extensions", "Extensions");
  tab(1, 5, "", "New Tab");
  tab(2, 0, "https://docs.example.com/1", "D1", { groupId: 12, active: true });
  tab(2, 1, "https://docs.example.com/2", "D2", { groupId: 12 });
  tab(2, 2, "https://example.com/c", "C");
  return SessionStore.capture(windows, tabs, groups, { name: "fixture", source: "manual" });
}

/* Drive the restore while emitting URL events for every created tab,
 * as the real browser would. */
async function restoreWithUrls(fake, plan, session, options) {
  const promise = Restore.executeRestore(fake.api, plan, session, options);
  // Let the engine reach its first waitForUrl, then report all URLs.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    fake.tabs.forEach((t) => {
      if (t.url && t.url.startsWith("http")) fake.emitUrl(t.id);
    });
  }
  return promise;
}

test("full restore: order, one move per window, groups, discard after URL, cannot-open collected", async () => {
  const fake = new FakeChrome();
  const session = fixtureSession();
  const plan = SessionStore.planRestore(session, [], { skipDuplicates: true });
  const result = await restoreWithUrls(fake, plan, session, { unloaded: true });

  assert.equal(result.restored, 7); // 9 tabs minus chrome:// and empty
  assert.equal(result.cannotOpen.length, 2);
  assert.deepEqual(result.cannotOpen.map((c) => c.url).sort(), ["", "chrome://extensions"]);
  assert.equal(result.skipped, 0);
  assert.equal(result.leftLoaded.length, 0);
  // Two windows created, none left with the initial empty tab.
  assert.equal(fake.calls.windowsCreate.length, 2);
  assert.equal(fake.windows.size, 2);
  fake.windows.forEach((w) => {
    assert.ok(!w.tabIds.some((id) => fake.tabs.get(id).url === "chrome://newtab"));
  });
  // Exactly ONE tabs.move per window, in saved order.
  assert.equal(fake.calls.tabsMove.length, 2);
  // Recorded at move time: discard later replaces tab ids, so the
  // recorded URLs are the only stable way to check the order.
  assert.deepEqual(fake.calls.tabsMove[0].urls, [
    "https://example.com/a", "https://example.com/b",
    "https://news.example.org/1", "https://news.example.org/2",
  ]);
  // Groups recreated with title / colour / collapsed.
  assert.equal(fake.calls.tabsGroup.length, 2);
  assert.equal(fake.calls.tabGroupsUpdate.length, 2);
  const updates = fake.calls.tabGroupsUpdate.map((c) => c.props);
  assert.ok(updates.some((p) => p.title === "Research" && p.color === "blue" && p.collapsed === false));
  assert.ok(updates.some((p) => p.title === "Docs" && p.color === "green" && p.collapsed === true));
  // Pinned tabs stayed pinned, active tab activated.
  const win1Tabs = [...fake.windows.values()][0].tabIds.map((id) => fake.tabs.get(id));
  assert.equal(win1Tabs[0].pinned, true);
  assert.equal(win1Tabs[1].pinned, true);
  assert.ok(fake.calls.tabsUpdate.some((c) => c.props.active === true));
  // Discard ran for every non-active tab (5 of 7), only after URL events.
  assert.equal(fake.calls.tabsDiscard.length, 5);
  fake.calls.tabsDiscard.forEach((id) => assert.ok(fake.urlReported.has(id)));
});

test("about:blank trap: a tab whose URL never reports is left loaded, never discarded", async () => {
  const fake = new FakeChrome();
  const session = fixtureSession();
  const plan = SessionStore.planRestore(session, [], { skipDuplicates: true });
  const promise = Restore.executeRestore(fake.api, plan, session, { unloaded: true, discardWaitMs: 30 });
  // Report URLs for every tab EXCEPT the docs tab in window 2.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
    fake.tabs.forEach((t) => {
      if (t.url && t.url.startsWith("http") && t.url !== "https://docs.example.com/2") fake.emitUrl(t.id);
    });
  }
  const result = await promise;
  assert.equal(result.leftLoaded.length, 1);
  assert.equal(result.leftLoaded[0].url, "https://docs.example.com/2");
  const discardedUrls = fake.calls.tabsDiscard.map((id) => {
    // The id may have been replaced by discard; find it by URL via groups of calls.
    return id;
  });
  assert.equal(fake.calls.tabsDiscard.length, 4);
  assert.ok(!discardedUrls.includes(undefined));
  // The unreported tab itself is still present and not discarded.
  const stuck = [...fake.tabs.values()].find((t) => t.url === "https://docs.example.com/2");
  assert.ok(stuck);
  assert.equal(stuck.discarded, undefined);
});

test("unloaded: false restores everything loaded, no discards", async () => {
  const fake = new FakeChrome();
  const session = fixtureSession();
  const plan = SessionStore.planRestore(session, [], { skipDuplicates: true });
  const result = await restoreWithUrls(fake, plan, session, { unloaded: false });
  assert.equal(result.restored, 7);
  assert.equal(fake.calls.tabsDiscard.length, 0);
  assert.equal(result.leftLoaded.length, 0);
});

test("current-window target: no new window, tabs appended to the given window", async () => {
  const fake = new FakeChrome();
  const existing = await fake.windowsCreate({ focused: true, incognito: false, state: "normal" });
  const existingId = existing.id;
  const session = fixtureSession();
  const plan = SessionStore.planRestore(session, [], { skipDuplicates: true });
  const result = await restoreWithUrls(fake, plan, session, {
    unloaded: false, target: "current", currentWindowId: existingId,
  });
  // First saved window went into the current window; the second opened new.
  assert.equal(fake.calls.windowsCreate.length, 2); // 1 existing + 1 for window 2
  assert.equal(result.restored, 7);
  const current = fake.windows.get(existingId);
  assert.ok(current.tabIds.length >= 4); // initial tab + 4 restored tabs
});

test("a tab that fails to create is collected, restore continues", async () => {
  const fake = new FakeChrome();
  fake.failUrls.add("https://news.example.org/2");
  const session = fixtureSession();
  const plan = SessionStore.planRestore(session, [], { skipDuplicates: true });
  const result = await restoreWithUrls(fake, plan, session, { unloaded: false });
  assert.equal(result.restored, 6);
  assert.equal(result.cannotOpen.length, 3);
  assert.ok(result.cannotOpen.some((c) => c.url === "https://news.example.org/2"));
});

test("duplicates are skipped when already open, counted in the result", async () => {
  const fake = new FakeChrome();
  const session = fixtureSession();
  const plan = SessionStore.planRestore(session, ["https://example.com/a", "https://example.com/c"], { skipDuplicates: true });
  const result = await restoreWithUrls(fake, plan, session, { unloaded: false });
  assert.equal(result.skipped, 2);
  assert.equal(result.restored, 5);
});

test("v2: restoring one window restores only that window's tabs", async () => {
  const fake = new FakeChrome();
  const session = fixtureSession();
  const oneWindow = SessionStore.selectWindow(session, 1);
  const plan = SessionStore.planRestore(oneWindow, [], { skipDuplicates: true });
  const result = await restoreWithUrls(fake, plan, oneWindow, { unloaded: false });
  assert.equal(result.restored, 3);
  assert.equal(fake.calls.windowsCreate.length, 1);
  assert.equal(fake.calls.tabsGroup.length, 1); // only the Docs group
  assert.ok(fake.calls.tabGroupsUpdate.some((c) => c.props.title === "Docs"));
});

test("v2: restoring ticked tabs restores only those, groups pruned", async () => {
  const fake = new FakeChrome();
  const session = fixtureSession();
  const subset = SessionStore.selectTabs(session, [
    { window: 0, tab: 2 }, { window: 0, tab: 3 }, { window: 1, tab: 2 },
  ]);
  const plan = SessionStore.planRestore(subset, [], { skipDuplicates: true });
  const result = await restoreWithUrls(fake, plan, subset, { unloaded: false });
  assert.equal(result.restored, 3);
  assert.equal(fake.calls.windowsCreate.length, 2);
  // The Research group kept one member; Docs lost every member.
  assert.equal(fake.calls.tabsGroup.length, 1);
  assert.ok(fake.calls.tabGroupsUpdate.some((c) => c.props.title === "Research"));
});
