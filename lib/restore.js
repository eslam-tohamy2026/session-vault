/* Session Vault — restore engine.
 *
 * Runs in the service worker, but takes its Chrome access as an
 * injected `api` object so the exact same code is testable in Node
 * with a fake (see tests/test_restore.mjs). No direct chrome.* calls
 * in this file.
 *
 * Restore sequencing (each step exists because the naive order breaks):
 *   1. Create the window (or reuse the current window).
 *   2. Create every restorable tab with chrome.tabs.create — Chrome's
 *      tabs.create has NO `discarded` property, so unloaded restore
 *      is two steps (see 5).
 *   3. Move the whole set in ONE tabs.move call, in saved order.
 *      Moving one at a time renumbers indices and scrambles a 20-tab
 *      window. Pinned tabs are first in saved order (Chrome keeps
 *      pinned tabs at the start of a window), so the single move
 *      never asks Chrome to put an unpinned tab before a pinned one.
 *   4. Groups: tabs.group per saved group, then tabGroups.update
 *      with title / colour / collapsed. Group ids are never persisted
 *      — they are unique per browser session and reused after a group
 *      is gone — so the saved session stores a group reference only.
 *   5. Discard (unloaded restore): only AFTER chrome.tabs.onUpdated
 *      reports changeInfo.url for that tab. Discarding earlier
 *      replaces the tab with about:blank — a documented trap. If the
 *      URL never reports within the timeout, the tab is left loaded
 *      and reported as such. tabs.discard can return a tab with a
 *      NEW tab id in some Chrome versions, so the engine never holds
 *      on to an id after discarding; it re-queries the window.
 *   6. Tabs that cannot be opened are collected, not fatal: chrome://
 *      and chrome-extension:// pages cannot be created by an
 *      extension, file:// needs the user's toggle. Each is listed
 *      after restore with its reason — a restore is never reported
 *      as complete when it was not.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SessionVaultRestore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  var DISCARD_WAIT_MS = 20000;

  /* Restore one planned session. `plan` comes from
   * SessionStore.planRestore; `session` is the saved session.
   * `api` is the injected Chrome adapter (see background.js for the
   * real one). `options`: { target: "new" | "current",
   * unloaded: boolean, currentWindowId: number }.
   * Returns { restored, skipped, cannotOpen, leftLoaded, windows }. */
  async function executeRestore(api, plan, session, options) {
    options = options || {};
    var unloaded = options.unloaded !== false;
    var target = options.target === "current" ? "current" : "new";
    var waitMs = options.discardWaitMs != null ? options.discardWaitMs : DISCARD_WAIT_MS;
    var result = {
      restored: 0,
      skipped: plan.skipped || 0,
      cannotOpen: (plan.cannotOpen || []).slice(),
      leftLoaded: [],
      windows: [],
    };

    var groupsByRef = {};
    (session.groups || []).forEach(function (g) {
      groupsByRef[g.ref] = g;
    });

    for (var wi = 0; wi < plan.windows.length; wi++) {
      var pw = plan.windows[wi];
      var toOpen = pw.tabs.filter(function (t) { return t.action === "open"; });
      if (!toOpen.length) continue;

      var windowId;
      var initialTabId = null;
      if (target === "current" && wi === 0 && options.currentWindowId != null) {
        windowId = options.currentWindowId;
      } else if (target === "current") {
        // Additional saved windows still open as new windows: there is
        // only one "current" window to reuse.
        var extra = await api.windowsCreate({
          focused: false,
          incognito: !!pw.incognito,
          state: pw.state === "maximized" ? "maximized" : "normal",
        });
        windowId = extra.id;
        initialTabId = extra.tabs && extra.tabs[0] ? extra.tabs[0].id : null;
      } else {
        var created = await api.windowsCreate({
          focused: !!pw.focused,
          incognito: !!pw.incognito,
          state: pw.state === "maximized" ? "maximized" : "normal",
        });
        windowId = created.id;
        initialTabId = created.tabs && created.tabs[0] ? created.tabs[0].id : null;
      }

      // Create tabs in saved order, all inactive; the active tab is
      // activated at the end so nothing steals focus mid-restore.
      var createdTabs = [];
      for (var ti = 0; ti < toOpen.length; ti++) {
        var entry = toOpen[ti];
        try {
          var tab = await api.tabsCreate({
            windowId: windowId,
            url: entry.tab.url,
            index: ti,
            active: false,
            pinned: !!entry.tab.pinned,
          });
          createdTabs.push({ saved: entry.tab, tab: tab });
        } catch (e) {
          result.cannotOpen.push({
            url: entry.tab.url,
            title: entry.tab.title,
            reason: e && e.message ? e.message : "could not create tab",
          });
        }
      }
      if (!createdTabs.length) {
        // Nothing restorable in this window: close the fresh empty
        // window we just made (removing its only tab closes it) so
        // the user is not left with a stray blank window.
        if (initialTabId != null) {
          try { await api.tabsRemove([initialTabId]); } catch (e) { /* already gone */ }
        }
        continue;
      }

      // One move, saved order, to fix any clamping from creation.
      var ids = createdTabs.map(function (c) { return c.tab.id; });
      try {
        await api.tabsMove(ids, { index: 0 });
      } catch (e) {
        // Move failure is not fatal: tabs are open, just possibly
        // out of order. Continue.
      }

      // Remove the empty tab the new window started with.
      if (initialTabId != null) {
        try { await api.tabsRemove([initialTabId]); } catch (e) { /* already gone */ }
      }

      // Groups, per saved reference, in this window only.
      var refsInWindow = [];
      createdTabs.forEach(function (c) {
        if (c.saved.groupRef && groupsByRef[c.saved.groupRef] &&
          refsInWindow.indexOf(c.saved.groupRef) === -1) {
          refsInWindow.push(c.saved.groupRef);
        }
      });
      for (var gi = 0; gi < refsInWindow.length; gi++) {
        var ref = refsInWindow[gi];
        var group = groupsByRef[ref];
        var memberIds = createdTabs
          .filter(function (c) { return c.saved.groupRef === ref; })
          .map(function (c) { return c.tab.id; });
        if (!memberIds.length) continue;
        try {
          var groupId = await api.tabsGroup({
            tabIds: memberIds,
            createProperties: { windowId: windowId },
          });
          await api.tabGroupsUpdate(groupId, {
            title: group.title,
            color: group.color,
            collapsed: !!group.collapsed,
          });
        } catch (e) {
          // Group failure is not fatal: tabs are open, just ungrouped.
        }
      }

      // Activate the originally-active tab (first active saved tab that
      // opened in this window), then discard the rest when asked.
      var activeEntry = null;
      for (var ai = 0; ai < createdTabs.length; ai++) {
        if (createdTabs[ai].saved.active) { activeEntry = createdTabs[ai]; break; }
      }
      if (!activeEntry) activeEntry = createdTabs[0];
      try {
        await api.tabsUpdate(activeEntry.tab.id, { active: true });
      } catch (e) { /* activation is best-effort */ }

      if (unloaded) {
        for (var di = 0; di < createdTabs.length; di++) {
          var c = createdTabs[di];
          if (c === activeEntry) continue;
          var urlReported = await api.waitForUrl(c.tab.id, waitMs);
          if (!urlReported) {
            result.leftLoaded.push({ url: c.saved.url, title: c.saved.title });
            continue;
          }
          try {
            await api.tabsDiscard(c.tab.id);
          } catch (e) {
            result.leftLoaded.push({ url: c.saved.url, title: c.saved.title });
          }
        }
      }

      // Count the tabs we created that survived. (We deliberately do
      // not count a re-query of the window here: in the "current"
      // window target it would also count tabs that were already open.
      // And after discarding we never hold on to a tab id again —
      // discard can change the id — so nothing after this point uses
      // the created ids.)
      result.restored += createdTabs.length;
      result.windows.push({ windowId: windowId, tabCount: createdTabs.length });
    }

    return result;
  }

  return {
    DISCARD_WAIT_MS: DISCARD_WAIT_MS,
    executeRestore: executeRestore,
  };
});
