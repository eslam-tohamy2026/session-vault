/* Session Vault — Node tests for the v2 additions in lib/sessionstore.js:
   per-window / selected-tab restore subsets, sorting, backup timing,
   import de-duplication and tags.
   Run: node --test tests/test_v2.mjs
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SessionStore = require("../lib/sessionstore.js");

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
  tab(1, 0, "https://example.com/a", "A", { active: true });
  tab(1, 1, "https://news.example.org/1", "N1", { groupId: 11 });
  tab(1, 2, "https://news.example.org/2", "N2", { groupId: 11 });
  tab(1, 3, "https://example.com/b", "B");
  tab(2, 0, "https://docs.example.com/1", "D1", { groupId: 12, active: true });
  tab(2, 1, "https://docs.example.com/2", "D2", { groupId: 12 });
  tab(2, 2, "https://example.com/c", "C");
  return SessionStore.capture(windows, tabs, groups, { name: "fixture", source: "manual" });
}

test("repairSlots: healing never parks the damaged slot as previous", () => {
  const good = { schemaVersion: 1, session: { name: "good" } };
  const damaged = { schemaVersion: 1, session: { name: "damaged" } };
  const repaired = SessionStore.repairSlots(
    { current: damaged, previous: good }, good);
  assert.equal(repaired.current, good);
  assert.equal(repaired.previous, good);
  assert.notEqual(repaired.previous, damaged);
  // No previous copy: previous stays null, never the damaged one.
  const repaired2 = SessionStore.repairSlots({ current: damaged, previous: null }, good);
  assert.equal(repaired2.current, good);
  assert.equal(repaired2.previous, null);
});

test("selectWindow: one window plus only the groups it uses", () => {
  const s = fixtureSession();
  const one = SessionStore.selectWindow(s, 1);
  assert.equal(one.windows.length, 1);
  assert.equal(SessionStore.countTabs(one), 3);
  assert.deepEqual(one.groups.map((g) => g.title), ["Docs"]);
  assert.equal(one.windows[0].tabs[0].url, "https://docs.example.com/1");
  // The original session is untouched.
  assert.equal(SessionStore.countWindows(s), 2);
  assert.equal(SessionStore.countTabs(s), 7);
  assert.equal(SessionStore.selectWindow(s, 5), null);
  assert.equal(SessionStore.selectWindow(s, -1), null);
});

test("selectTabs: picked tabs only, groups pruned, order kept, original untouched", () => {
  const s = fixtureSession();
  // Pick the two grouped news tabs (window 1) and the last tab of window 2,
  // deliberately out of order: saved order must win.
  const sub = SessionStore.selectTabs(s, [
    { window: 1, tab: 2 }, { window: 0, tab: 2 }, { window: 0, tab: 1 },
  ]);
  assert.equal(SessionStore.countWindows(sub), 2);
  assert.equal(SessionStore.countTabs(sub), 3);
  assert.deepEqual(sub.windows[0].tabs.map((t) => t.url), [
    "https://news.example.org/1", "https://news.example.org/2",
  ]);
  assert.deepEqual(sub.windows[1].tabs.map((t) => t.url), ["https://example.com/c"]);
  // Only the Research group survives; Docs lost every member.
  assert.deepEqual(sub.groups.map((g) => g.title), ["Research"]);
  assert.equal(SessionStore.countTabs(s), 7);
  assert.equal(SessionStore.selectTabs(s, []), null);
  assert.equal(SessionStore.selectTabs(s, [{ window: 9, tab: 0 }]), null);
});

test("sortSessions: newest, oldest, name, tabs — input never mutated", () => {
  const entries = [
    { id: "b", name: "Beta", updatedAt: 2000, tabCount: 3 },
    { id: "a", name: "Alpha", updatedAt: 1000, tabCount: 9 },
    { id: "c", name: "Gamma", updatedAt: 3000, tabCount: 1 },
  ];
  assert.deepEqual(SessionStore.sortSessions(entries, "newest").map((e) => e.id), ["c", "b", "a"]);
  assert.deepEqual(SessionStore.sortSessions(entries, "oldest").map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(SessionStore.sortSessions(entries, "name").map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(SessionStore.sortSessions(entries, "tabs").map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(SessionStore.sortSessions(entries, "bogus").map((e) => e.id), ["c", "b", "a"]);
  assert.deepEqual(entries.map((e) => e.id), ["b", "a", "c"]);
});

test("needsBackup: a manual save counts, no change means no write", () => {
  const live = { updatedAt: 1000 };
  const sessions = [{ updatedAt: 500 }, { updatedAt: 1500 }];
  assert.equal(SessionStore.needsBackup(sessions, live, 1000), true); // manual save at 1500
  assert.equal(SessionStore.needsBackup(sessions, live, 1500), false);
  assert.equal(SessionStore.needsBackup(sessions, live, 2000), false);
  // No live snapshot yet, but saved sessions exist: still back up.
  assert.equal(SessionStore.needsBackup(sessions, null, 0), true);
  assert.equal(SessionStore.needsBackup([], null, 0), false);
});

test("resolveImport: identical re-import skipped, colliding id gets a fresh one", () => {
  const s = fixtureSession();
  const stored = [s];
  // Exact re-import: skipped, nothing to save.
  let r = SessionStore.resolveImport(stored, [JSON.parse(JSON.stringify(s))]);
  assert.equal(r.save.length, 0);
  assert.equal(r.skipped, 1);
  // Same id, different content (renamed): saved under a NEW id, the
  // stored session is never overwritten.
  const renamed = JSON.parse(JSON.stringify(s));
  renamed.name = "renamed copy";
  r = SessionStore.resolveImport(stored, [renamed]);
  assert.equal(r.save.length, 1);
  assert.equal(r.skipped, 0);
  assert.notEqual(r.save[0].id, s.id);
  assert.equal(r.save[0].name, "renamed copy");
  // A v1 session stored without a tags field still matches its
  // re-import (normalised on both sides).
  const v1 = JSON.parse(JSON.stringify(s));
  delete v1.tags;
  r = SessionStore.resolveImport([v1], [JSON.parse(JSON.stringify(s))]);
  assert.equal(r.save.length, 0);
  assert.equal(r.skipped, 1);
  // Brand-new session: saved as-is.
  const fresh = fixtureSession();
  r = SessionStore.resolveImport(stored, [fresh]);
  assert.equal(r.save.length, 1);
  assert.equal(r.save[0].id, fresh.id);
});

test("cleanTags: trims, dedupes, caps at 10 and 30 characters", () => {
  assert.deepEqual(SessionStore.cleanTags([" work ", "work", "research", ""]), ["work", "research"]);
  assert.deepEqual(SessionStore.cleanTags(null), []);
  assert.deepEqual(SessionStore.cleanTags(["x".repeat(40)]), ["x".repeat(30)]);
  const many = Array.from({ length: 12 }, (_, i) => "t" + i);
  assert.equal(SessionStore.cleanTags(many).length, 10);
});

test("tags survive validate + normalise + export/import round-trip", () => {
  const bad = SessionStore.validateSession({
    id: "1", name: "x", windows: [], groups: [], tags: "not-an-array",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("tags")));
  const s = fixtureSession();
  s.tags = ["work", "research"];
  const text = SessionStore.exportJson([s]);
  const { sessions, errors } = SessionStore.importJson(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(sessions[0].tags, ["work", "research"]);
  assert.deepEqual(sessions[0], s);
});

test("importTabSessionManagerJson: tags imported, groups honestly ungrouped", () => {
  const { sessions } = SessionStore.importTabSessionManagerJson(JSON.stringify([
    { name: "Tagged", tags: ["work", "later"], tabs: [{ url: "https://example.com/", title: "Home" }] },
  ]));
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].tags, ["work", "later"]);
  assert.equal(sessions[0].windows[0].tabs[0].groupRef, null);
});
