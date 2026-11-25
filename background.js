/* Session Vault — service worker (background.js).
 *
 * All top-level listeners, no polling loops. Two kinds of timers
 * exist here and they are not the same thing:
 *   - the 2-second auto-save debounce uses setTimeout. If the worker
 *     is terminated mid-debounce, the save is not lost: the dirty
 *     flag lives in chrome.storage.session and the 5-minute alarm
 *     backstop re-captures it. The plan's "no timers" rule is about
 *     the backstop (alarms persist across restarts; setTimeout does
 *     not), not about a 2-second debounce.
 *   - alarms (autosave-check every 5 min, file-backup every 15 min)
 *     persist across restarts and wake the worker.
 *
 * All state that must survive a worker restart lives in storage,
 * never in memory. Every listener is registered at the top level so
 * a woken worker re-registers before dispatching.
 *
 * The three copies: (1) IndexedDB is the primary store, (2) a
 * rotating pair of slots in chrome.storage.local is the mirror,
 * (3) a dated JSON file in a folder the user chose is the outside
 * copy. Every snapshot carries a SHA-256 checksum; on startup the
 * mirror is verified and healed from the next good copy.
 */

importScripts("lib/sessionstore.js", "lib/idb.js", "lib/backup.js", "lib/restore.js");

var SessionStore = self.SessionStore;
var Idb = self.SessionVaultIdb;
var Backup = self.SessionVaultBackup;
var RestoreEngine = self.SessionVaultRestore;

var LIVE_GENERATIONS_KEPT = 10;
var TRASH_DAYS = 30;

/* ---------- small helpers ---------- */

function sha256Hex(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then(function (hash) {
    var view = new Uint8Array(hash);
    var out = "";
    for (var i = 0; i < view.length; i++) {
      out += ("0" + view[i].toString(16)).slice(-2);
    }
    return out;
  });
}

function localGet(keys) {
  return chrome.storage.local.get(keys);
}

function localSet(obj) {
  return chrome.storage.local.set(obj);
}

function sessionGet(keys) {
  return chrome.storage.session.get(keys);
}

function sessionSet(obj) {
  return chrome.storage.session.set(obj);
}

function broadcast(message) {
  // No listener is fine — the manager page may simply not be open.
  try {
    chrome.runtime.sendMessage(message).catch(function () { /* nobody listening */ });
  } catch (e) { /* extension pages only */ }
}

function logError(where, e) {
  try {
    console.error("[Session Vault] " + where + ":", e);
  } catch (ignored) { /* logging must never throw */ }
}

/* ---------- capture ---------- */

async function captureAll(source) {
  var windows = await chrome.windows.getAll({ populate: false });
  var tabs = await chrome.tabs.query({});
  var groups = await chrome.tabGroups.query({});
  return SessionStore.capture(windows, tabs, groups, { source: source || "auto" });
}

async function captureCurrentWindow(source) {
  var win = await chrome.windows.getCurrent({ populate: false });
  var tabs = await chrome.tabs.query({ windowId: win.id });
  var groups = await chrome.tabGroups.query({ windowId: win.id });
  return SessionStore.capture([win], tabs, groups, { source: source || "manual" });
}

/* ---------- the three copies ---------- */

/* Write the live snapshot to IndexedDB (__live__ + one generation
 * record) and to the mirror pair. Mirror write order: stage the new
 * envelope, read it back and verify it, then rotate — a torn write
 * can only ever damage the slot being written. */
async function saveLive(session) {
  await Idb.putSession(Object.assign({}, session, { id: Idb.LIVE_ID }));
  var genId = "__live-gen-" + Date.now() + "__";
  await Idb.putSession(Object.assign({}, session, { id: genId }));
  await pruneLiveGenerations();

  var sha = await SessionStore.checksum(session, sha256Hex);
  var envelope = SessionStore.makeEnvelope(session, sha);
  await localSet({ "sv.autosave.staging": envelope });
  var staged = await localGet("sv.autosave.staging");
  var stagedOk = staged["sv.autosave.staging"] &&
    await SessionStore.verifyEnvelope(staged["sv.autosave.staging"], sha256Hex);
  if (!stagedOk) {
    await localSet({ "sv.integrity": {
      status: "error", checkedAt: Date.now(),
      message: "Mirror write did not verify — the browser copy is still the last good one.",
    } });
    return false;
  }
  var slots = await localGet(["sv.autosave.current", "sv.autosave.previous"]);
  var rotated = SessionStore.rotateSlots(
    { current: slots["sv.autosave.current"] || null, previous: slots["sv.autosave.previous"] || null },
    envelope);
  await localSet({
    "sv.autosave.current": rotated.current,
    "sv.autosave.previous": rotated.previous,
    "sv.autosave.staging": null,
  });
  await localSet({ "sv.integrity": {
    status: "ok", checkedAt: Date.now(), source: "mirror",
    message: "All copies verified",
  } });
  return true;
}

async function pruneLiveGenerations() {
  try {
    var all = await Idb.listSessions();
    var gens = all
      .filter(function (s) { return s.id.indexOf("__live-gen-") === 0; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    for (var i = LIVE_GENERATIONS_KEPT; i < gens.length; i++) {
      await Idb.deleteSession(gens[i].id);
    }
  } catch (e) {
    logError("pruneLiveGenerations", e);
  }
}

/* Verify the mirror pair and the IndexedDB live copy; heal the mirror
 * from the next good copy. Returns the integrity record. */
async function verifyCopies() {
  var slots = await localGet(["sv.autosave.current", "sv.autosave.previous"]);
  var healed = await SessionStore.healSlots(
    { current: slots["sv.autosave.current"] || null, previous: slots["sv.autosave.previous"] || null },
    sha256Hex);
  var record = {
    status: "ok", checkedAt: Date.now(), source: healed.source,
    message: "All copies verified",
  };
  if (healed.envelope) {
    if (healed.healed) {
      // Repair the damaged current slot from the previous good one.
      var rotated = SessionStore.rotateSlots(
        { current: slots["sv.autosave.current"] || null, previous: slots["sv.autosave.previous"] || null },
        healed.envelope);
      await localSet({
        "sv.autosave.current": rotated.current,
        "sv.autosave.previous": rotated.previous,
      });
      record.status = "healed";
      record.message = "Recovered your sessions from the backup copy — 1 copy was damaged.";
    }
    // Keep IndexedDB in step: if its live copy differs, rewrite it.
    try {
      var live = await Idb.getSession(Idb.LIVE_ID);
      var liveSha = live ? await SessionStore.checksum(live, sha256Hex) : null;
      if (liveSha !== healed.envelope.sha256) {
        await Idb.putSession(Object.assign({}, healed.envelope.session, { id: Idb.LIVE_ID }));
      }
    } catch (e) {
      logError("verifyCopies idb", e);
    }
  } else if (healed.damaged) {
    record.status = "error";
    record.message = "Both backup copies failed verification. Your saved sessions in the library are unaffected.";
  } else {
    record.status = "empty";
    record.message = "No auto-save yet — it starts on the first tab change.";
  }
  await localSet({ "sv.integrity": record });
  return record;
}

/* ---------- auto-save ---------- */

var saveTimer = null;

function markDirty() {
  sessionSet({ svDirty: true }).catch(function () { /* best effort */ });
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    doAutosave().catch(function (e) { logError("doAutosave", e); });
  }, 2000);
}

async function doAutosave() {
  var flags = await sessionGet("svDirty");
  if (!flags.svDirty && saveTimer) return;
  var session;
  try {
    session = await captureAll("auto");
  } catch (e) {
    logError("captureAll", e);
    return;
  }
  var ok = await saveLive(session);
  await sessionSet({ svDirty: false, svLastSeenTabs: SessionStore.countTabs(session) });
  var now = Date.now();
  await localSet({ "sv.settings.lastAutosaveAt": now });
  broadcast({ type: "autosaved", at: now, tabs: SessionStore.countTabs(session), ok: ok });
}

/* ---------- index (fast list for the manager page) ---------- */

function indexEntry(session) {
  var titles = [];
  var urls = [];
  session.windows.forEach(function (w) {
    w.tabs.forEach(function (t) {
      if (t.title && titles.length < 10) titles.push(t.title);
      if (t.url && urls.length < 10) urls.push(t.url);
    });
  });
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    source: session.source,
    windowCount: SessionStore.countWindows(session),
    tabCount: SessionStore.countTabs(session),
    titles: titles,
    urls: urls,
  };
}

async function rebuildIndex() {
  var all = await Idb.listSessions();
  var sessions = all.filter(function (s) {
    return s.id !== Idb.LIVE_ID && s.id.indexOf("__live-gen-") !== 0 && !s.trashedAt;
  });
  sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  var index = sessions.map(indexEntry);
  await localSet({ "sv.index": index });
  return index;
}

async function pruneTrash() {
  var cutoff = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
  var all = await Idb.listSessions();
  for (var i = 0; i < all.length; i++) {
    if (all[i].trashedAt && all[i].trashedAt < cutoff) {
      await Idb.deleteSession(all[i].id);
    }
  }
}

/* ---------- file backup (copy 3) ---------- */

async function writeDailyBackupIfDue() {
  try {
    var handle = await Idb.getMeta("backupHandle");
    if (!handle) return { ok: false, error: "no backup folder chosen" };
    var settings = await localGet("sv.settings.lastBackupAt");
    var lastBackup = settings["sv.settings.lastBackupAt"] || 0;
    var live = await Idb.getSession(Idb.LIVE_ID);
    if (!live) return { ok: false, error: "nothing to back up yet" };
    if (live.updatedAt <= lastBackup) return { ok: true, skipped: true };
    var all = await Idb.listSessions();
    var sessions = all.filter(function (s) {
      return s.id !== Idb.LIVE_ID && s.id.indexOf("__live-gen-") !== 0 && !s.trashedAt;
    });
    var json = SessionStore.exportJson(sessions, { live: live });
    var permitted = await Backup.ensurePermission(handle);
    if (!permitted) return { ok: false, error: "backup folder permission revoked — pick the folder again" };
    var result = await Backup.writeDailyBackup(handle, json, new Date());
    if (result.ok) {
      await localSet({ "sv.settings.lastBackupAt": Date.now() });
    }
    return result;
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function writeManualBackup(session) {
  try {
    var handle = await Idb.getMeta("backupHandle");
    if (!handle) return { ok: false, error: "no backup folder chosen" };
    var permitted = await Backup.ensurePermission(handle);
    if (!permitted) return { ok: false, error: "backup folder permission revoked — pick the folder again" };
    var json = SessionStore.exportJson([session]);
    return await Backup.writeManualBackup(handle, session.name, json, new Date());
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ---------- crash recovery ---------- */

async function checkRecovery() {
  try {
    var live = await Idb.getSession(Idb.LIVE_ID);
    if (!live) {
      await sessionSet({ svRecovery: null });
      return null;
    }
    var current = await captureAll("auto");
    var diff = SessionStore.diffSnapshots(live, current);
    if (!diff.isRecovery) {
      await sessionSet({ svRecovery: null });
      await chrome.action.setBadgeText({ text: "" });
      return null;
    }
    var recovery = {
      snapshotAt: live.updatedAt,
      tabCount: diff.savedTabCount,
      windowCount: SessionStore.countWindows(live),
      missingCount: diff.missingCount,
    };
    await sessionSet({ svRecovery: recovery });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#D97706" });
    return recovery;
  } catch (e) {
    logError("checkRecovery", e);
    return null;
  }
}

/* ---------- the real Chrome adapter for the restore engine ---------- */

function chromeAdapter() {
  var pendingUrlWaiters = new Map();
  function onUpdated(tabId, changeInfo) {
    if (!changeInfo || !changeInfo.url) return;
    var list = pendingUrlWaiters.get(tabId);
    if (!list) return;
    pendingUrlWaiters.delete(tabId);
    list.forEach(function (resolve) { resolve(true); });
  }
  chrome.tabs.onUpdated.addListener(onUpdated);
  return {
    windowsCreate: function (opts) { return chrome.windows.create(opts); },
    tabsCreate: function (opts) { return chrome.tabs.create(opts); },
    tabsMove: function (ids, opts) { return chrome.tabs.move(ids, opts); },
    tabsGroup: function (opts) { return chrome.tabs.group(opts); },
    tabGroupsUpdate: function (id, props) { return chrome.tabGroups.update(id, props); },
    tabsUpdate: function (id, props) { return chrome.tabs.update(id, props); },
    tabsRemove: function (ids) { return chrome.tabs.remove(ids); },
    tabsDiscard: function (id) { return chrome.tabs.discard(id); },
    tabsQuery: function (q) { return chrome.tabs.query(q); },
    waitForUrl: function (tabId, timeoutMs) {
      return new Promise(function (resolve) {
        var list = pendingUrlWaiters.get(tabId) || [];
        list.push(resolve);
        pendingUrlWaiters.set(tabId, list);
        setTimeout(function () {
          var remaining = pendingUrlWaiters.get(tabId);
          if (!remaining) return;
          var idx = remaining.indexOf(resolve);
          if (idx !== -1) remaining.splice(idx, 1);
          if (!remaining.length) pendingUrlWaiters.delete(tabId);
          resolve(false);
        }, timeoutMs);
      });
    },
    dispose: function () {
      chrome.tabs.onUpdated.removeListener(onUpdated);
    },
  };
}

/* ---------- events ---------- */

chrome.tabs.onCreated.addListener(markDirty);
chrome.tabs.onRemoved.addListener(markDirty);
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.url || changeInfo.pinned !== undefined || changeInfo.groupId !== undefined) markDirty();
});
chrome.tabs.onMoved.addListener(markDirty);
chrome.tabs.onAttached.addListener(markDirty);
chrome.tabs.onDetached.addListener(markDirty);
chrome.tabs.onActivated.addListener(markDirty);
chrome.windows.onCreated.addListener(markDirty);
chrome.windows.onRemoved.addListener(markDirty);
chrome.tabGroups.onCreated.addListener(markDirty);
chrome.tabGroups.onUpdated.addListener(markDirty);
chrome.tabGroups.onRemoved.addListener(markDirty);
chrome.tabGroups.onMoved.addListener(markDirty);

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === "autosave-check") {
    sessionGet("svDirty").then(function (flags) {
      if (flags.svDirty) doAutosave().catch(function (e) { logError("alarm autosave", e); });
    });
  } else if (alarm.name === "file-backup") {
    writeDailyBackupIfDue().then(function (result) {
      if (!result.ok && result.error !== "no backup folder chosen" && !result.skipped) {
        localSet({ "sv.settings.backupError": result.error }).catch(function () {});
        broadcast({ type: "backup-failed", error: result.error });
      } else {
        localSet({ "sv.settings.backupError": null }).catch(function () {});
      }
    }).catch(function (e) { logError("alarm file-backup", e); });
  }
});

function createAlarms() {
  chrome.alarms.create("autosave-check", { periodInMinutes: 5 });
  chrome.alarms.create("file-backup", { periodInMinutes: 15 });
}

chrome.runtime.onInstalled.addListener(function () {
  createAlarms();
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () { /* best effort */ });
  }
  rebuildIndex().catch(function (e) { logError("rebuildIndex onInstalled", e); });
  pruneTrash().catch(function (e) { logError("pruneTrash onInstalled", e); });
});

chrome.runtime.onStartup.addListener(function () {
  createAlarms();
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () { /* best effort */ });
  }
  verifyCopies()
    .then(function () { return checkRecovery(); })
    .then(function () { return pruneTrash(); })
    .catch(function (e) { logError("onStartup", e); });
});

/* ---------- messages from popup / manager ---------- */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  (async function () {
    var type = message && message.type;
    if (type === "listSessions") {
      var index = await localGet("sv.index");
      sendResponse({ index: index["sv.index"] || await rebuildIndex() });
    } else if (type === "getSession") {
      sendResponse({ session: await Idb.getSession(message.id) });
    } else if (type === "saveSession") {
      var session = message.scope === "window"
        ? await captureCurrentWindow("manual")
        : await captureAll("manual");
      if (message.name) session.name = message.name;
      await Idb.putSession(session);
      await rebuildIndex();
      var backup = await writeManualBackup(session);
      broadcast({ type: "session-saved", id: session.id, backup: backup });
      sendResponse({ session: session, backup: backup });
    } else if (type === "renameSession") {
      var toRename = await Idb.getSession(message.id);
      if (!toRename) { sendResponse({ error: "session not found" }); return; }
      toRename.name = message.name;
      toRename.updatedAt = Date.now();
      await Idb.putSession(toRename);
      await rebuildIndex();
      sendResponse({ session: toRename });
    } else if (type === "deleteSession") {
      var toDelete = await Idb.getSession(message.id);
      if (!toDelete) { sendResponse({ error: "session not found" }); return; }
      toDelete.trashedAt = Date.now();
      await Idb.putSession(toDelete);
      await rebuildIndex();
      sendResponse({ ok: true });
    } else if (type === "listTrash") {
      var all = await Idb.listSessions();
      var trash = all.filter(function (s) { return !!s.trashedAt; })
        .sort(function (a, b) { return (b.trashedAt || 0) - (a.trashedAt || 0); });
      sendResponse({ trash: trash.map(indexEntry) });
    } else if (type === "restoreFromTrash") {
      var trashed = await Idb.getSession(message.id);
      if (!trashed) { sendResponse({ error: "session not found" }); return; }
      delete trashed.trashedAt;
      trashed.updatedAt = Date.now();
      await Idb.putSession(trashed);
      await rebuildIndex();
      sendResponse({ session: trashed });
    } else if (type === "purgeTrash") {
      await pruneTrash();
      sendResponse({ ok: true });
    } else if (type === "previewRestore") {
      var previewTarget = await Idb.getSession(message.id);
      if (!previewTarget) { sendResponse({ error: "session not found" }); return; }
      var openForPreview = await chrome.tabs.query({});
      var previewPlan = SessionStore.planRestore(
        previewTarget, openForPreview.map(function (t) { return t.url; }), { skipDuplicates: true });
      sendResponse({
        toOpen: previewPlan.toOpen,
        skipped: previewPlan.skipped,
        cannotOpen: previewPlan.cannotOpen,
      });
    } else if (type === "restoreSession") {
      var target = await Idb.getSession(message.id);
      if (!target) { sendResponse({ error: "session not found" }); return; }
      var openTabs = await chrome.tabs.query({});
      var plan = SessionStore.planRestore(target, openTabs.map(function (t) { return t.url; }), {
        skipDuplicates: message.options ? message.options.skipDuplicates !== false : true,
      });
      var adapter = chromeAdapter();
      var currentWindow = null;
      if (message.options && message.options.target === "current") {
        currentWindow = await chrome.windows.getCurrent();
      }
      var result;
      try {
        result = await RestoreEngine.executeRestore(adapter, plan, target, {
          target: message.options ? message.options.target : "new",
          unloaded: message.options ? message.options.unloaded !== false : true,
          currentWindowId: currentWindow ? currentWindow.id : null,
        });
      } finally {
        adapter.dispose();
      }
      markDirty();
      sendResponse({ result: result });
    } else if (type === "exportSession") {
      var one = await Idb.getSession(message.id);
      if (!one) { sendResponse({ error: "session not found" }); return; }
      sendResponse({ json: SessionStore.exportJson([one]) });
    } else if (type === "exportAll") {
      var allSessions = await Idb.listSessions();
      var kept = allSessions.filter(function (s) {
        return s.id !== Idb.LIVE_ID && s.id.indexOf("__live-gen-") !== 0 && !s.trashedAt;
      });
      var live = await Idb.getSession(Idb.LIVE_ID);
      sendResponse({ json: SessionStore.exportJson(kept, { live: live }) });
    } else if (type === "importData") {
      var imported = message.format === "onetab"
        ? SessionStore.importOneTabText(message.text)
        : message.format === "tsm"
          ? SessionStore.importTabSessionManagerJson(message.text)
          : SessionStore.importJson(message.text);
      for (var i = 0; i < imported.sessions.length; i++) {
        await Idb.putSession(imported.sessions[i]);
      }
      if (imported.sessions.length) await rebuildIndex();
      sendResponse({ imported: imported.sessions.length, errors: imported.errors });
    } else if (type === "getIntegrity") {
      var integrity = await localGet("sv.integrity");
      sendResponse({ integrity: integrity["sv.integrity"] || null });
    } else if (type === "verifyNow") {
      sendResponse({ integrity: await verifyCopies() });
    } else if (type === "getRecovery") {
      var recovery = await sessionGet("svRecovery");
      var recentlyClosed = [];
      try {
        recentlyClosed = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
      } catch (e) { logError("getRecentlyClosed", e); }
      sendResponse({ recovery: recovery.svRecovery || null, recentlyClosed: recentlyClosed });
    } else if (type === "dismissRecovery") {
      await sessionSet({ svRecovery: null });
      await chrome.action.setBadgeText({ text: "" });
      sendResponse({ ok: true });
    } else if (type === "restoreRecentlyClosed") {
      try {
        var restored = await chrome.sessions.restore(message.sessionId);
        markDirty();
        sendResponse({ ok: true, restored: !!restored });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    } else if (type === "restoreLiveSnapshot") {
      var liveSession = await Idb.getSession(Idb.LIVE_ID);
      if (!liveSession) { sendResponse({ error: "no auto-save snapshot yet" }); return; }
      var openNow = await chrome.tabs.query({});
      var livePlan = SessionStore.planRestore(liveSession, openNow.map(function (t) { return t.url; }), { skipDuplicates: true });
      var liveAdapter = chromeAdapter();
      var liveResult;
      try {
        liveResult = await RestoreEngine.executeRestore(liveAdapter, livePlan, liveSession, { target: "new", unloaded: true });
      } finally {
        liveAdapter.dispose();
      }
      await sessionSet({ svRecovery: null });
      await chrome.action.setBadgeText({ text: "" });
      markDirty();
      sendResponse({ result: liveResult });
    } else if (type === "getBackupStatus") {
      var hasHandle = !!(await Idb.getMeta("backupHandle"));
      var backupSettings = await localGet(["sv.settings.lastBackupAt", "sv.settings.backupError"]);
      var folderName = null;
      try {
        var handle = await Idb.getMeta("backupHandle");
        folderName = handle ? handle.name : null;
      } catch (e) { /* no handle */ }
      sendResponse({
        supported: Backup.isSupported(),
        hasFolder: hasHandle,
        folderName: folderName,
        lastBackupAt: backupSettings["sv.settings.lastBackupAt"] || null,
        error: backupSettings["sv.settings.backupError"] || null,
      });
    } else if (type === "getLastAutosave") {
      var last = await localGet("sv.settings.lastAutosaveAt");
      sendResponse({ at: last["sv.settings.lastAutosaveAt"] || null });
    } else if (type === "backupNow") {
      sendResponse(await writeDailyBackupIfDue());
    } else {
      sendResponse({ error: "unknown message type: " + type });
    }
  })().catch(function (e) {
    logError("onMessage " + (message && message.type), e);
    try { sendResponse({ error: e && e.message ? e.message : String(e) }); } catch (ignored) { /* channel closed */ }
  });
  return true; // async response
});
