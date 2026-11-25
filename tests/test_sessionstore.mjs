/* Session Vault — Node tests for lib/sessionstore.js.
   All pure functions, no chrome.* anywhere in this file.
   Run: node --test tests/test_sessionstore.mjs
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SessionStore = require("../lib/sessionstore.js");

function digest(bytes) {
  return Promise.resolve(createHash("sha256").update(bytes).digest("hex"));
}

/* A fake browser state: 3 windows, 40 tabs, 2 groups in window 1,
 * 1 group in window 2, pinned tabs, one duplicate URL, one chrome://
 * tab and one empty tab. */
function fakeBrowser() {
  const windows = [
    { id: 1, focused: true, incognito: false, state: "normal", name: null },
    { id: 2, focused: false, incognito: false, state: "maximized", name: null },
    { id: 3, focused: false, incognito: true, state: "normal", name: null },
  ];
  const groups = [
    { id: 101, title: "Research", color: "blue", collapsed: false, windowId: 1 },
    { id: 102, title: "Shopping", color: "orange", collapsed: true, windowId: 1 },
    { id: 103, title: "Docs", color: "green", collapsed: false, windowId: 2 },
  ];
  const tabs = [];
  let n = 0;
  function tab(windowId, index, url, title, extra) {
    n += 1;
    tabs.push(Object.assign({
      id: n, windowId, index, url, title,
      pinned: false, active: false, groupId: -1, discarded: false,
    }, extra || {}));
  }
  // Window 1: 15 tabs — group 101 (5 tabs), group 102 (3), rest ungrouped.
  tab(1, 0, "https://example.com/a", "Example A", { active: true });
  tab(1, 1, "https://example.com/b", "Example B", { pinned: true });
  tab(1, 2, "https://news.example.org/1", "News 1", { groupId: 101 });
  tab(1, 3, "https://news.example.org/2", "News 2", { groupId: 101 });
  tab(1, 4, "https://news.example.org/3", "News 3", { groupId: 101 });
  tab(1, 5, "https://news.example.org/4", "News 4", { groupId: 101 });
  tab(1, 6, "https://news.example.org/5", "News 5", { groupId: 101 });
  tab(1, 7, "https://shop.example.com/x", "Shop X", { groupId: 102 });
  tab(1, 8, "https://shop.example.com/y", "Shop Y", { groupId: 102 });
  tab(1, 9, "https://shop.example.com/z", "Shop Z", { groupId: 102 });
  tab(1, 10, "https://example.com/c", "Example C");
  tab(1, 11, "https://example.com/d", "Example D");
  tab(1, 12, "https://example.com/e", "Example E");
  tab(1, 13, "chrome://extensions", "Extensions");
  tab(1, 14, "", "New Tab");
  // Window 2: 12 tabs — group 103 (4), one duplicate of example.com/a.
  tab(2, 0, "https://docs.example.com/1", "Doc 1", { groupId: 103 });
  tab(2, 1, "https://docs.example.com/2", "Doc 2", { groupId: 103 });
  tab(2, 2, "https://docs.example.com/3", "Doc 3", { groupId: 103 });
  tab(2, 3, "https://docs.example.com/4", "Doc 4", { groupId: 103 });
  tab(2, 4, "https://example.com/a", "Example A (again)");
  tab(2, 5, "https://example.com/f", "Example F");
  tab(2, 6, "https://example.com/g", "Example G");
  tab(2, 7, "https://example.com/h", "Example H");
  tab(2, 8, "https://example.com/i", "Example I");
  tab(2, 9, "https://example.com/j", "Example J");
  tab(2, 10, "https://example.com/k", "Example K");
  tab(2, 11, "https://example.com/l", "Example L");
  // Window 3 (incognito): 13 tabs, no groups.
  for (let i = 0; i < 13; i++) {
    tab(3, i, "https://private.example.com/p" + (i + 1), "Private " + (i + 1),
      i === 0 ? { active: true } : {});
  }
  return { windows, tabs, groups, total: tabs.length };
}

test("capture: 3 windows / 40 tabs, order, groups by reference, pinned flags", () => {
  const { windows, tabs, groups, total } = fakeBrowser();
  assert.equal(total, 40);
  const s = SessionStore.capture(windows, tabs, groups, { source: "manual", now: 1795000000000 });
  assert.equal(SessionStore.countWindows(s), 3);
  assert.equal(SessionStore.countTabs(s), 40);
  // Tab order inside each window follows index.
  assert.equal(s.windows[0].tabs[0].url, "https://example.com/a");
  assert.equal(s.windows[0].tabs[14].url, "");
  assert.equal(s.windows[2].tabs[12].url, "https://private.example.com/p13");
  // Pinned flags survive.
  assert.equal(s.windows[0].tabs[1].pinned, true);
  assert.equal(s.windows[0].tabs[0].pinned, false);
  // Active tabs survive.
  assert.equal(s.windows[0].tabs[0].active, true);
  assert.equal(s.windows[2].tabs[0].active, true);
  // Groups are stored by reference, never by Chrome's numeric id.
  assert.deepEqual(s.groups.map((g) => g.ref), ["g1", "g2", "g3"]);
  assert.deepEqual(s.groups.map((g) => g.title), ["Research", "Shopping", "Docs"]);
  assert.equal(s.groups[1].collapsed, true);
  assert.equal(s.groups[0].color, "blue");
  assert.equal(s.windows[0].tabs[2].groupRef, "g1");
  assert.equal(s.windows[0].tabs[7].groupRef, "g2");
  assert.equal(s.windows[1].tabs[0].groupRef, "g3");
  assert.equal(s.windows[0].tabs[0].groupRef, null);
  // Window state / incognito survive.
  assert.equal(s.windows[1].state, "maximized");
  assert.equal(s.windows[2].incognito, true);
  assert.equal(s.windows[0].focused, true);
  // The duplicate URL is captured twice (capture does not drop tabs).
  const dupes = s.windows.flatMap((w) => w.tabs).filter((t) => t.url === "https://example.com/a");
  assert.equal(dupes.length, 2);
  // The chrome:// tab and the empty tab are captured, not dropped.
  assert.equal(s.windows[0].tabs[13].url, "chrome://extensions");
  assert.equal(s.windows[0].tabs[14].url, "");
});

test("normaliseUrl: case, fragment and trailing slash", () => {
  assert.equal(SessionStore.normaliseUrl("https://EXAMPLE.com/Path/#frag"), "https://example.com/Path");
  assert.equal(SessionStore.normaliseUrl("https://example.com/a/"), "https://example.com/a");
  assert.equal(SessionStore.normaliseUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(SessionStore.normaliseUrl("chrome://extensions"), null);
  assert.equal(SessionStore.normaliseUrl(""), null);
  assert.equal(SessionStore.normaliseUrl("  https://example.com/x  "), "https://example.com/x");
});

test("cannotOpenReason: browser pages, file URLs, empty tabs", () => {
  assert.match(SessionStore.cannotOpenReason("chrome://extensions"), /browser page/);
  assert.match(SessionStore.cannotOpenReason("chrome-extension://abc/options.html"), /browser page/);
  assert.match(SessionStore.cannotOpenReason("file:///home/x/doc.pdf"), /file:\/\/ URL/);
  assert.match(SessionStore.cannotOpenReason(""), /empty tab/);
  assert.equal(SessionStore.cannotOpenReason("https://example.com/"), null);
});

test("dedupeTabs: first occurrence kept, duplicates counted", () => {
  const { windows, tabs, groups } = fakeBrowser();
  const s = SessionStore.capture(windows, tabs, groups);
  const all = s.windows.flatMap((w) => w.tabs);
  const { tabs: kept, duplicates } = SessionStore.dedupeTabs(all);
  assert.equal(kept.length, 39);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].url, "https://example.com/a");
});

test("planRestore: duplicates skipped, cannot-open collected, counts reported", () => {
  const { windows, tabs, groups } = fakeBrowser();
  const s = SessionStore.capture(windows, tabs, groups);
  const openUrls = ["https://example.com/a", "https://example.com/f", "https://docs.example.com/1"];
  const plan = SessionStore.planRestore(s, openUrls, { skipDuplicates: true });
  // 40 tabs: 4 skipped (example.com/a appears twice in the session and
  // is open, plus example.com/f and docs.example.com/1), 2 cannot open
  // (chrome:// + empty).
  assert.equal(plan.skipped, 4);
  assert.equal(plan.cannotOpen.length, 2);
  assert.equal(plan.toOpen, 34);
  assert.deepEqual(
    plan.cannotOpen.map((c) => c.url).sort(),
    ["", "chrome://extensions"].sort());
  // With duplicates allowed, everything openable opens.
  const plan2 = SessionStore.planRestore(s, openUrls, { skipDuplicates: false });
  assert.equal(plan2.skipped, 0);
  assert.equal(plan2.toOpen, 38);
  assert.equal(plan2.cannotOpen.length, 2);
});

test("diffSnapshots: recovery check finds missing tabs", () => {
  const { windows, tabs, groups } = fakeBrowser();
  const saved = SessionStore.capture(windows, tabs, groups);
  // Current state: window 3 (incognito) is gone entirely.
  const current = SessionStore.capture(windows.slice(0, 2), tabs.filter((t) => t.windowId !== 3), groups);
  const diff = SessionStore.diffSnapshots(saved, current);
  assert.equal(diff.isRecovery, true);
  assert.equal(diff.missingCount, 13);
  assert.equal(diff.savedTabCount, 40);
  assert.equal(diff.currentTabCount, 27);
  // Identical snapshots are not a recovery.
  const same = SessionStore.diffSnapshots(saved, saved);
  assert.equal(same.isRecovery, false);
  assert.equal(same.missingCount, 0);
});

test("checksum + envelope: one-character change fails verification", async () => {
  const { windows, tabs, groups } = fakeBrowser();
  const s = SessionStore.capture(windows, tabs, groups);
  const sha = await SessionStore.checksum(s, digest);
  const env = SessionStore.makeEnvelope(s, sha);
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.tabCount, 40);
  assert.equal(env.windowCount, 3);
  assert.equal(await SessionStore.verifyEnvelope(env, digest), true);
  // Change one character in one title.
  const tampered = JSON.parse(JSON.stringify(env));
  tampered.session.windows[0].tabs[0].title = "Example B";
  assert.equal(await SessionStore.verifyEnvelope(tampered, digest), false);
  // Wrong schema version fails.
  const wrongVersion = JSON.parse(JSON.stringify(env));
  wrongVersion.schemaVersion = 99;
  assert.equal(await SessionStore.verifyEnvelope(wrongVersion, digest), false);
  // Same session always hashes the same way (canonical JSON).
  const sha2 = await SessionStore.checksum(s, digest);
  assert.equal(sha2, sha);
});

test("rotateSlots + healSlots: a torn write damages only the slot being written", async () => {
  const { windows, tabs, groups } = fakeBrowser();
  const s1 = SessionStore.capture(windows, tabs, groups, { name: "first" });
  const s2 = SessionStore.capture(windows, tabs, groups, { name: "second" });
  const env1 = SessionStore.makeEnvelope(s1, await SessionStore.checksum(s1, digest));
  const env2 = SessionStore.makeEnvelope(s2, await SessionStore.checksum(s2, digest));
  // Rotate: env2 becomes current, env1 becomes previous.
  let slots = SessionStore.rotateSlots({ current: null, previous: null }, env1);
  slots = SessionStore.rotateSlots(slots, env2);
  assert.equal(slots.current.session.name, "second");
  assert.equal(slots.previous.session.name, "first");
  // Both verify: the current copy is used, nothing healed.
  let healed = await SessionStore.healSlots(slots, digest);
  assert.equal(healed.source, "current");
  assert.equal(healed.healed, false);
  // Simulate a torn write: corrupt the current slot's payload.
  const torn = JSON.parse(JSON.stringify(slots));
  torn.current.session.windows[0].tabs[0].title = "CORRUPTED";
  healed = await SessionStore.healSlots(torn, digest);
  assert.equal(healed.source, "previous");
  assert.equal(healed.healed, true);
  assert.equal(healed.envelope.session.name, "first");
  // Both slots damaged: nothing to heal from, reported honestly.
  const bothBad = JSON.parse(JSON.stringify(slots));
  bothBad.current.session.windows[0].tabs[0].title = "X";
  bothBad.previous.session.windows[0].tabs[0].title = "Y";
  healed = await SessionStore.healSlots(bothBad, digest);
  assert.equal(healed.envelope, null);
  assert.equal(healed.source, null);
  assert.equal(healed.damaged, true);
  // Empty mirror: null, not damaged.
  healed = await SessionStore.healSlots({ current: null, previous: null }, digest);
  assert.equal(healed.envelope, null);
  assert.equal(healed.damaged, false);
});

test("export/import round-trip: identical session back", () => {
  const { windows, tabs, groups } = fakeBrowser();
  const s = SessionStore.capture(windows, tabs, groups, { name: "round trip", source: "manual" });
  const text = SessionStore.exportJson([s]);
  const { sessions, errors } = SessionStore.importJson(text);
  assert.deepEqual(errors, []);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], s);
});

test("importJson: corrupt files are rejected with specific errors, never a crash", () => {
  let r = SessionStore.importJson("this is not json");
  assert.equal(r.sessions.length, 0);
  assert.match(r.errors[0], /not valid JSON/);
  r = SessionStore.importJson(JSON.stringify({ format: "session-vault", schemaVersion: 1, sessions: [] }));
  assert.equal(r.sessions.length, 0);
  assert.match(r.errors.join(" "), /no sessions found/);
  r = SessionStore.importJson(JSON.stringify({
    format: "session-vault", schemaVersion: 1,
    sessions: [{ id: "x" }], // missing name, windows
  }));
  assert.equal(r.sessions.length, 0);
  assert.match(r.errors[0], /missing name/);
  assert.match(r.errors[0], /windows is not an array/);
  r = SessionStore.importJson(JSON.stringify({
    format: "session-vault", schemaVersion: 99, sessions: [],
  }));
  assert.match(r.errors.join(" "), /unsupported schemaVersion 99/);
  // One good session + one bad one: the good one still imports.
  const { windows, tabs, groups } = fakeBrowser();
  const good = SessionStore.capture(windows, tabs, groups, { name: "good" });
  r = SessionStore.importJson(JSON.stringify({
    format: "session-vault", schemaVersion: 1,
    sessions: [good, { id: "bad" }],
  }));
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].name, "good");
  assert.equal(r.errors.length, 1);
});

test("importOneTabText: groups and names survive", () => {
  const text = [
    "Research",
    "https://news.example.org/1 | News 1",
    "https://news.example.org/2 | News 2",
    "not a url at all",
    "",
    "https://example.com/a | Example A",
    "https://example.com/b",
    "",
    "https://example.com/c | Example C",
  ].join("\n");
  const { sessions, errors } = SessionStore.importOneTabText(text);
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.match(s.name, /Imported from OneTab/);
  assert.equal(SessionStore.countTabs(s), 5);
  // The "Research" block became a group; its tabs carry the reference.
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].title, "Research");
  assert.equal(s.windows[0].tabs[0].groupRef, "g1");
  assert.equal(s.windows[0].tabs[0].title, "News 1");
  assert.equal(s.windows[0].tabs[2].groupRef, null);
  assert.equal(s.windows[0].tabs[2].title, "Example A");
  assert.equal(s.windows[0].tabs[3].title, "");
  // The stray non-URL line was reported, not fatal.
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a URL/);
  const empty = SessionStore.importOneTabText("");
  assert.equal(empty.sessions.length, 0);
  assert.match(empty.errors.join(" "), /no tabs found/);
});

test("importTabSessionManagerJson: names and tabs survive, flat and windowed forms", () => {
  const tsm = JSON.stringify({
    sessions: [
      {
        name: "Morning research", date: 1795000000000,
        tabs: [
          { url: "https://example.com/a", title: "A" },
          { url: "https://example.com/b", title: "B", pinned: true },
        ],
      },
      {
        name: "Two windows",
        windows: [
          { tabs: [{ url: "https://x.example.com/1", title: "X1" }] },
          { tabs: [{ url: "https://y.example.com/2", title: "Y2" }] },
        ],
      },
      { name: "Empty one", tabs: [] },
    ],
  });
  const { sessions, errors } = SessionStore.importTabSessionManagerJson(tsm);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].name, "Morning research");
  assert.equal(sessions[0].windows[0].tabs[1].pinned, true);
  assert.equal(sessions[1].windows.length, 2);
  assert.equal(SessionStore.countTabs(sessions[1]), 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no tabs, skipped/);
  // Bare-array form also works.
  const bare = SessionStore.importTabSessionManagerJson(JSON.stringify([
    { name: "Bare", tabs: [{ url: "https://example.com/", title: "Home" }] },
  ]));
  assert.equal(bare.sessions.length, 1);
  assert.equal(bare.sessions[0].name, "Bare");
  const bad = SessionStore.importTabSessionManagerJson("nope");
  assert.equal(bad.sessions.length, 0);
  assert.match(bad.errors[0], /not valid JSON/);
});

test("validateSession: specific errors per problem", () => {
  const ok = SessionStore.validateSession({
    id: "1", name: "x", schemaVersion: 1, windows: [], groups: [],
  });
  assert.equal(ok.ok, true);
  const bad = SessionStore.validateSession({
    id: "", name: 5, windows: [{ tabs: [{ url: 1, title: "t", pinned: "yes", active: true }] }],
    groups: [{ ref: "g1" }],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("missing id")));
  assert.ok(bad.errors.some((e) => e.includes("missing name")));
  assert.ok(bad.errors.some((e) => e.includes(".url is not a string")));
  assert.ok(bad.errors.some((e) => e.includes(".pinned is not a boolean")));
  assert.ok(bad.errors.some((e) => e.includes("groups[0].title")));
});
