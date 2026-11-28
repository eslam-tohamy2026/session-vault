/* Session Vault — manager page logic.
 * The manager is a view: all storage lives in the service worker.
 * The one thing the manager does itself is the backup folder: the
 * File System Access picker needs a window and a user gesture, so it
 * can never run in the worker. The directory handle is stored in
 * IndexedDB (meta store) for the worker to reuse.
 *
 * Restore granularity: a whole session, one window, or just the tabs
 * you tick. Every variant goes through the same confirmation dialog
 * and the same plan (duplicates skipped, cannot-open tabs listed),
 * so a partial restore is reported just as honestly as a whole one.
 */

(function () {
  "use strict";

  var SessionStore = window.SessionStore;
  var Idb = window.SessionVaultIdb;
  var Backup = window.SessionVaultBackup;

  /* The manager page is also served as a public preview on GitHub Pages,
   * where the extension APIs do not exist. Detect that up front: in
   * preview mode the page shows a notice and sample sessions, and
   * disables every action that needs the extension, instead of hanging
   * on "Saving…" forever. */
  var HAS_EXTENSION = (typeof chrome !== "undefined" && chrome.runtime &&
    chrome.runtime.sendMessage);

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    index: [],
    trash: [],
    closed: [],
    view: "sessions",
    selectedId: null,
    selectedSession: null,
    search: "",
    sort: "newest",
    tagFilter: null,
    selection: {}, // "windowIndex:tabIndex" -> true, for restore-selected
    pendingRestore: null, // { kind: "session"|"window"|"selection", windowIndex, picks }
    integrity: null,
    recovery: null,
    backup: null,
    samples: null, // id -> session, preview mode only
  };

  function send(message) {
    if (!HAS_EXTENSION) {
      return Promise.resolve({ ok: false, error: "The Session Vault extension is not running on this page." });
    }
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ ok: false, error: "The extension did not answer in time." });
      }, 30000);
      chrome.runtime.sendMessage(message, function (response) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(response || {});
      });
    });
  }

  function setStatus(text) {
    $("status").textContent = text;
  }

  function fmtTime(ts) {
    if (!ts) return "Unknown time";
    return new Date(ts).toLocaleString([], {
      day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function selectionCount() {
    var n = 0;
    Object.keys(state.selection).forEach(function (k) {
      if (state.selection[k]) n += 1;
    });
    return n;
  }

  function clearSelection() {
    state.selection = {};
  }

  /* ---------- top bar ---------- */

  function renderIntegrity() {
    var badge = $("integrity-badge");
    var i = state.integrity;
    badge.className = "badge";
    if (!i) {
      badge.classList.add("badge-unknown");
      badge.textContent = "Checking…";
      badge.title = "Verifying stored copies…";
      return;
    }
    if (i.status === "ok") {
      if (state.backup && !state.backup.hasFolder) {
        badge.classList.add("badge-warn");
        badge.textContent = "Backup folder not set";
        badge.title = "Sessions are verified, but no copy lives outside the browser yet.";
      } else {
        badge.classList.add("badge-ok");
        badge.textContent = "All copies verified";
        badge.title = "Checked " + fmtClock(i.checkedAt) + " — IndexedDB, mirror and file copies agree.";
      }
    } else if (i.status === "healed") {
      badge.classList.add("badge-warn");
      badge.textContent = "Recovered from backup copy";
      badge.title = i.message;
      showIntegrityAlert(i.message);
    } else if (i.status === "error") {
      badge.classList.add("badge-bad");
      badge.textContent = "Copy damaged";
      badge.title = i.message;
      showIntegrityAlert(i.message);
    } else {
      badge.classList.add("badge-unknown");
      badge.textContent = "No auto-save yet";
      badge.title = i.message || "Auto-save starts on the first tab change.";
    }
  }

  function showIntegrityAlert(text) {
    $("integrity-alert-text").textContent = text;
    $("integrity-alert").hidden = false;
  }

  function renderBackup() {
    var b = state.backup;
    var el = $("backup-status");
    if (!b) { el.textContent = "Backup: checking…"; return; }
    if (!b.supported) {
      el.textContent = "Backup: file access not available in this browser";
      $("backup-warning").hidden = true;
      return;
    }
    if (!b.hasFolder) {
      el.textContent = "Backup: browser only";
      maybeShowBackupWarning();
    } else {
      el.textContent = "Backed up to " + (b.folderName || "chosen folder") +
        (b.lastBackupAt ? " · " + fmtTime(b.lastBackupAt) : " · not yet");
      $("backup-warning").hidden = true;
    }
    if (b.error) {
      el.textContent += " — backup failed: " + b.error;
    }
  }

  function maybeShowBackupWarning() {
    if (!HAS_EXTENSION) { $("backup-warning").hidden = true; return; }
    chrome.storage.local.get("sv.backupWarningDismissedAt", function (r) {
      var dismissedAt = r["sv.backupWarningDismissedAt"] || 0;
      var today = new Date().toDateString();
      var dismissedToday = new Date(dismissedAt).toDateString() === today;
      $("backup-warning").hidden = dismissedToday;
    });
  }

  /* ---------- recovery banner ---------- */

  function renderRecovery() {
    var r = state.recovery;
    var banner = $("recovery-banner");
    if (!r) { banner.hidden = true; return; }
    banner.hidden = false;
    $("recovery-text").textContent =
      "Snapshot from " + fmtClock(r.snapshotAt) + " — " + r.windowCount +
      " window(s), " + r.tabCount + " tab(s), " + r.missingCount + " missing now.";
  }

  /* ---------- session list ---------- */

  function filteredIndex() {
    var q = state.search.trim().toLowerCase();
    var list = state.index;
    if (state.tagFilter) {
      list = list.filter(function (entry) {
        return (entry.tags || []).indexOf(state.tagFilter) !== -1;
      });
    }
    if (q) {
      list = list.filter(function (entry) {
        if (entry.name.toLowerCase().indexOf(q) !== -1) return true;
        if ((entry.tags || []).some(function (t) { return t.toLowerCase().indexOf(q) !== -1; })) return true;
        return (entry.titles || []).some(function (t) { return t.toLowerCase().indexOf(q) !== -1; }) ||
          (entry.urls || []).some(function (u) { return u.toLowerCase().indexOf(q) !== -1; });
      });
    }
    return SessionStore.sortSessions(list, state.sort);
  }

  function renderTagFilter() {
    var wrap = $("tag-filter");
    var counts = {};
    state.index.forEach(function (entry) {
      (entry.tags || []).forEach(function (t) {
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    var tags = Object.keys(counts).sort();
    wrap.innerHTML = "";
    if (!tags.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    tags.forEach(function (tag) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-chip" + (state.tagFilter === tag ? " active" : "");
      btn.textContent = tag + " (" + counts[tag] + ")";
      btn.title = state.tagFilter === tag ? "Show all sessions" : "Show only sessions tagged “" + tag + "”";
      btn.addEventListener("click", function () {
        state.tagFilter = state.tagFilter === tag ? null : tag;
        renderTagFilter();
        renderList();
      });
      wrap.appendChild(btn);
    });
  }

  function renderList() {
    var list = $("session-list");
    list.innerHTML = "";
    var items = [];
    if (state.view === "sessions") {
      items = filteredIndex().map(function (entry) {
        return {
          key: entry.id, title: entry.name,
          meta: fmtTime(entry.updatedAt) + " · " + entry.windowCount + " window(s) · " +
            entry.tabCount + " tab(s)",
          badge: entry.source === "manual" ? "Manual" : entry.source === "crash" ? "Recovered" : "Auto",
          badgeClass: entry.source,
          tags: entry.tags || [],
        };
      });
    } else if (state.view === "trash") {
      items = state.trash.map(function (entry) {
        return {
          key: entry.id, title: entry.name,
          meta: "Deleted " + fmtTime(entry.trashedAt || entry.updatedAt) +
            " · " + entry.windowCount + " window(s) · " + entry.tabCount + " tab(s)",
          badge: "Trash", badgeClass: "",
          tags: entry.tags || [],
        };
      });
    } else {
      items = state.closed.map(function (c, i) {
        var label = c.tab ? (c.tab.title || c.tab.url || "Tab")
          : c.window ? (c.window.tabs ? c.window.tabs.length + " tabs" : "Window") : "Closed item";
        return {
          key: "closed-" + i, title: label,
          meta: c.lastModified ? fmtTime(c.lastModified * 1000) : "Recently closed",
          badge: c.tab ? "Tab" : "Window", badgeClass: "",
          closed: c,
          tags: [],
        };
      });
    }

    if (!items.length) {
      var li = document.createElement("li");
      li.textContent = state.view === "sessions"
        ? (state.search || state.tagFilter ? "No sessions match." : "No saved sessions yet.")
        : state.view === "trash"
          ? "Trash is empty."
          : "Nothing recently closed.";
      li.style.cursor = "default";
      list.appendChild(li);
    }
    items.forEach(function (item) {
      var li = document.createElement("li");
      if (item.key === state.selectedId) li.classList.add("selected");
      var tagHtml = (item.tags || []).map(function (t) {
        return "<span class=\"tag-chip tag-static\">" + escapeHtml(t) + "</span>";
      }).join("");
      li.innerHTML = "<div class=\"name\">" + escapeHtml(item.title) +
        "<span class=\"source-badge " + item.badgeClass + "\">" + escapeHtml(item.badge) + "</span></div>" +
        (tagHtml ? "<div class=\"tag-row\">" + tagHtml + "</div>" : "") +
        "<div class=\"meta\">" + escapeHtml(item.meta) + "</div>";
      li.addEventListener("click", function () {
        if (state.view === "closed") {
          restoreRecentlyClosed(item.closed);
        } else if (state.view === "trash") {
          selectSession(item.key, true);
        } else {
          selectSession(item.key, false);
        }
      });
      list.appendChild(li);
    });
    $("empty-trash-btn").hidden = state.view !== "trash" || !state.trash.length;
    var totalTabs = state.index.reduce(function (n, e) { return n + e.tabCount; }, 0);
    $("counts").textContent = state.index.length + " session(s) · " + totalTabs + " tab(s) saved";
  }

  /* ---------- session detail ---------- */

  function renderDetail() {
    var s = state.selectedSession;
    $("empty-state").hidden = !!s;
    $("session-detail").hidden = !s;
    if (!s) return;
    var inTrash = state.view === "trash";
    $("detail-name").textContent = s.name;
    var tabs = SessionStore.countTabs(s);
    $("detail-meta").textContent = fmtTime(s.updatedAt) + " · " +
      SessionStore.countWindows(s) + " window(s) · " + tabs + " tab(s) · " +
      (s.source === "manual" ? "Saved manually" : s.source === "crash" ? "Recovered after a crash" : "Auto-saved");
    var tagsWrap = $("detail-tags");
    tagsWrap.innerHTML = "";
    (s.tags || []).forEach(function (t) {
      var chip = document.createElement("span");
      chip.className = "tag-chip tag-static";
      chip.textContent = t;
      tagsWrap.appendChild(chip);
    });
    // A trashed session gets restore / delete-forever instead of the
    // normal restore bar: there is no point offering "Restore…" for
    // something that is already in the trash.
    $("restore-bar").hidden = inTrash;
    $("trash-bar").hidden = !inTrash;
    $("rename-btn").hidden = inTrash;
    $("export-text-btn").hidden = inTrash;
    updateSelectionBar();
    var wrap = $("detail-windows");
    wrap.innerHTML = "";
    var groupByRef = {};
    (s.groups || []).forEach(function (g) { groupByRef[g.ref] = g; });
    s.windows.forEach(function (w, wi) {
      var block = document.createElement("div");
      block.className = "window-block";
      var pinnedCount = w.tabs.filter(function (t) { return t.pinned; }).length;
      var head = document.createElement("div");
      head.className = "window-head";
      head.innerHTML = "<h3>Window " + (wi + 1) +
        (w.focused ? " · focused" : "") +
        (w.incognito ? " · incognito" : "") +
        (w.state && w.state !== "normal" ? " · " + escapeHtml(w.state) : "") +
        (pinnedCount ? " · <span class=\"pinned-note\">" + pinnedCount + " pinned</span>" : "") +
        "</h3>";
      if (!inTrash && HAS_EXTENSION) {
        var winBtn = document.createElement("button");
        winBtn.type = "button";
        winBtn.className = "window-restore";
        winBtn.textContent = "Restore this window";
        winBtn.title = "Restore only this window (" + w.tabs.length + " tab(s))";
        winBtn.addEventListener("click", function () {
          openRestoreDialog({ kind: "window", windowIndex: wi });
        });
        head.appendChild(winBtn);
      }
      block.appendChild(head);
      var ul = document.createElement("ul");
      ul.className = "tab-list";
      w.tabs.forEach(function (t, ti) {
        var li = document.createElement("li");
        var group = t.groupRef ? groupByRef[t.groupRef] : null;
        var key = wi + ":" + ti;
        var checked = state.selection[key] ? " checked" : "";
        var box = (!inTrash && HAS_EXTENSION)
          ? "<input type=\"checkbox\" class=\"tab-check\" data-key=\"" + key + "\"" + checked +
            " title=\"Tick to include this tab in Restore selected\" aria-label=\"Select tab\">"
          : "";
        var openBtn = (!inTrash && HAS_EXTENSION)
          ? "<button type=\"button\" class=\"tab-open\" data-url=\"" + escapeHtml(t.url || "") +
            "\" title=\"Open this one tab now\">Open</button>"
          : "";
        li.innerHTML = box +
          (t.pinned ? "<span class=\"tab-pin\">PINNED</span>" : "") +
          (group ? "<span class=\"group-chip " + escapeHtml(group.color) + "\">" +
            escapeHtml(group.title || "Group") + "</span>" : "") +
          "<span class=\"tab-title\">" + escapeHtml(t.title || "(no title)") + "</span>" +
          "<span class=\"tab-url\">" + escapeHtml(t.url || "(empty tab)") + "</span>" +
          openBtn;
        ul.appendChild(li);
      });
      block.appendChild(ul);
      wrap.appendChild(block);
    });
    // Wire the checkboxes and per-tab Open buttons after render.
    var checks = wrap.querySelectorAll ? wrap.querySelectorAll(".tab-check") : [];
    for (var ci = 0; ci < checks.length; ci++) {
      checks[ci].addEventListener("change", function (e) {
        var k = e.target.getAttribute("data-key");
        if (e.target.checked) state.selection[k] = true;
        else delete state.selection[k];
        updateSelectionBar();
      });
    }
    var opens = wrap.querySelectorAll ? wrap.querySelectorAll(".tab-open") : [];
    for (var oi = 0; oi < opens.length; oi++) {
      opens[oi].addEventListener("click", function (e) {
        e.stopPropagation();
        openSingleTab(e.target.getAttribute("data-url"));
      });
    }
  }

  function updateSelectionBar() {
    var n = selectionCount();
    var btn = $("restore-selected-btn");
    btn.hidden = n === 0;
    if (n) btn.textContent = "Restore selected (" + n + ")";
    var s = state.selectedSession;
    if (s) {
      $("restore-hint").textContent = "Restores " + SessionStore.countTabs(s) + " tab(s) in " +
        SessionStore.countWindows(s) + " window(s). Tabs open unloaded by default." +
        (n ? " " + n + " ticked." : " Tick tabs to restore just some of them.");
    }
  }

  function openSingleTab(url) {
    if (!url || !HAS_EXTENSION) return;
    chrome.tabs.create({ url: url });
    setStatus("Opened tab.");
  }

  /* ---------- actions ---------- */

  function refreshAll() {
    return Promise.all([
      send({ type: "listSessions" }).then(function (r) { state.index = r.index || []; }),
      send({ type: "getIntegrity" }).then(function (r) { state.integrity = r.integrity; }),
      send({ type: "getBackupStatus" }).then(function (r) { state.backup = r; }),
      send({ type: "getRecovery" }).then(function (r) {
        state.recovery = r.recovery || null;
        state.closed = r.recentlyClosed || [];
      }),
    ]).then(function () {
      renderIntegrity();
      renderBackup();
      renderRecovery();
      renderTagFilter();
      renderList();
      renderDetail();
    });
  }

  function selectSession(id, fromTrash) {
    state.selectedId = id;
    clearSelection();
    if (!HAS_EXTENSION && state.samples) {
      state.selectedSession = state.samples[id] || null;
      renderList();
      renderDetail();
      return;
    }
    if (fromTrash) {
      send({ type: "listTrash" }).then(function (r) {
        var entry = (r.trash || []).find(function (e) { return e.id === id; });
        if (!entry) return;
        send({ type: "getSession", id: id }).then(function (g) {
          state.selectedSession = g.session;
          renderList();
          renderDetail();
        });
      });
      return;
    }
    send({ type: "getSession", id: id }).then(function (r) {
      state.selectedSession = r.session;
      renderList();
      renderDetail();
    });
  }

  function saveSession(scope) {
    setStatus("Saving…");
    send({ type: "saveSession", scope: scope }).then(function (r) {
      if (r.error) { setStatus("Could not save: " + r.error); return; }
      var count = SessionStore.countTabs(r.session);
      setStatus("Saved “" + r.session.name + "” — " + count + " tab(s)." +
        (r.backup && !r.backup.ok ? " (File backup failed: " + r.backup.error + ")" : ""));
      state.selectedId = r.session.id;
      state.selectedSession = r.session;
      refreshAll();
    });
  }

  /* Open the restore confirmation for a whole session, one window, or
   * the ticked tabs. The preview comes from the background so the
   * duplicate / cannot-open counts are computed against the tabs
   * actually open right now. */
  function openRestoreDialog(pending) {
    var s = state.selectedSession;
    if (!s) return;
    state.pendingRestore = pending;
    var subset = pending.kind === "window"
      ? SessionStore.selectWindow(s, pending.windowIndex)
      : pending.kind === "selection"
        ? SessionStore.selectTabs(s, pending.picks)
        : s;
    if (!subset) { setStatus("Nothing to restore."); return; }
    send({ type: "previewRestore", id: s.id, windowIndex: pending.windowIndex, picks: pending.picks }).then(function (r) {
      if (r.error) { setStatus("Could not preview restore: " + r.error); return; }
      var tabs = SessionStore.countTabs(subset);
      var what = pending.kind === "window"
        ? "Window " + (pending.windowIndex + 1) + " of “" + s.name + "”"
        : pending.kind === "selection"
          ? "Selected tabs of “" + s.name + "”"
          : "“" + s.name + "”";
      $("restore-summary").textContent = what + " — " + tabs + " tab(s) in " +
        SessionStore.countWindows(subset) + " window(s).";
      $("restore-dupe-count").textContent = r.skipped
        ? "(" + r.skipped + " already open — will be skipped)"
        : "";
      var co = $("restore-cannot-open");
      if (r.cannotOpen && r.cannotOpen.length) {
        co.hidden = false;
        co.textContent = r.cannotOpen.length + " tab(s) cannot be opened: " +
          r.cannotOpen.map(function (c) { return c.title || c.url; }).join(", ") + ".";
      } else {
        co.hidden = true;
      }
      $("restore-dialog").showModal();
    });
  }

  function doRestore() {
    var s = state.selectedSession;
    var pending = state.pendingRestore || { kind: "session" };
    if (!s) return;
    var options = {
      target: $("restore-target").value,
      skipDuplicates: $("restore-skip-dupes").checked,
      unloaded: $("restore-unloaded").checked,
    };
    var message = pending.kind === "window"
      ? { type: "restoreWindow", id: s.id, windowIndex: pending.windowIndex, options: options }
      : pending.kind === "selection"
        ? { type: "restoreSelection", id: s.id, picks: pending.picks, options: options }
        : { type: "restoreSession", id: s.id, options: options };
    setStatus("Restoring…");
    send(message).then(function (r) {
      if (r.error) { setStatus("Restore failed: " + r.error); return; }
      var res = r.result;
      var parts = ["Restored " + res.restored + " tab(s)"];
      if (res.skipped) parts.push(res.skipped + " already open — skipped");
      if (res.cannotOpen.length) parts.push(res.cannotOpen.length + " could not be opened");
      if (res.leftLoaded.length) parts.push(res.leftLoaded.length + " left loaded (never finished loading)");
      setStatus(parts.join(" · ") + ".");
      clearSelection();
      refreshAll();
    });
  }

  function restoreRecentlyClosed(closed) {
    if (!closed || !closed.sessionId) return;
    setStatus("Restoring…");
    send({ type: "restoreRecentlyClosed", sessionId: closed.sessionId }).then(function (r) {
      setStatus(r.ok ? "Restored." : "Could not restore: " + (r.error || "unknown error"));
      refreshAll();
    });
  }

  /* ---------- wiring ---------- */

  $("save-all").addEventListener("click", function () { saveSession("all"); });
  $("save-window").addEventListener("click", function () { saveSession("window"); });
  $("empty-save").addEventListener("click", function () { saveSession("all"); });

  $("search").addEventListener("input", function (e) {
    state.search = e.target.value;
    renderList();
  });

  $("sort").addEventListener("change", function (e) {
    state.sort = e.target.value;
    renderList();
  });

  function setView(view) {
    state.view = view;
    state.selectedId = null;
    state.selectedSession = null;
    clearSelection();
    ["sessions", "trash", "closed"].forEach(function (v) {
      $("view-" + v).classList.toggle("active", v === view);
    });
    if (view === "trash") {
      if (!HAS_EXTENSION) {
        state.trash = [];
        renderList();
        renderDetail();
        return;
      }
      send({ type: "listTrash" }).then(function (r) {
        state.trash = r.trash || [];
        renderList();
        renderDetail();
      });
    } else {
      renderList();
      renderDetail();
    }
  }
  $("view-sessions").addEventListener("click", function () { setView("sessions"); });
  $("view-trash").addEventListener("click", function () { setView("trash"); });
  $("view-closed").addEventListener("click", function () { setView("closed"); });

  $("restore-btn").addEventListener("click", function () { openRestoreDialog({ kind: "session" }); });
  $("restore-selected-btn").addEventListener("click", function () {
    var picks = Object.keys(state.selection).filter(function (k) { return state.selection[k]; })
      .map(function (k) {
        var parts = k.split(":");
        return { window: parseInt(parts[0], 10), tab: parseInt(parts[1], 10) };
      });
    openRestoreDialog({ kind: "selection", picks: picks });
  });
  $("restore-confirm").addEventListener("click", function () { doRestore(); });
  $("restore-cancel").addEventListener("click", function () { $("restore-dialog").close(); });

  $("rename-btn").addEventListener("click", function () {
    if (!state.selectedSession) return;
    $("rename-input").value = state.selectedSession.name;
    $("rename-tags").value = (state.selectedSession.tags || []).join(", ");
    $("rename-dialog").showModal();
  });
  $("rename-confirm").addEventListener("click", function () {
    var name = $("rename-input").value.trim();
    var tags = $("rename-tags").value.split(",").map(function (t) { return t.trim(); })
      .filter(function (t) { return !!t; });
    if (!name || !state.selectedSession) return;
    send({
      type: "updateSessionMeta",
      id: state.selectedSession.id, name: name, tags: tags,
    }).then(function (r) {
      if (r.error) { setStatus("Rename failed: " + r.error); return; }
      state.selectedSession = r.session;
      setStatus("Saved.");
      refreshAll();
    });
  });
  $("rename-cancel").addEventListener("click", function () { $("rename-dialog").close(); });

  $("delete-btn").addEventListener("click", function () {
    if (!state.selectedSession) return;
    var name = state.selectedSession.name;
    send({ type: "deleteSession", id: state.selectedSession.id }).then(function (r) {
      if (r.error) { setStatus("Delete failed: " + r.error); return; }
      state.selectedId = null;
      state.selectedSession = null;
      setStatus("Moved “" + name + "” to Trash — kept 30 days, restorable from the Trash tab.");
      refreshAll();
    });
  });

  $("trash-restore-btn").addEventListener("click", function () {
    if (!state.selectedSession) return;
    send({ type: "restoreFromTrash", id: state.selectedSession.id }).then(function (r) {
      if (r.error) { setStatus("Restore failed: " + r.error); return; }
      setStatus("Restored “" + r.session.name + "” to the library.");
      setView("sessions");
      refreshAll();
    });
  });
  $("trash-delete-btn").addEventListener("click", function () {
    if (!state.selectedSession) return;
    if (!window.confirm("Permanently delete “" + state.selectedSession.name + "”? This cannot be undone.")) return;
    var name = state.selectedSession.name;
    send({ type: "deleteSessionForever", id: state.selectedSession.id }).then(function (r) {
      if (r.error) { setStatus("Delete failed: " + r.error); return; }
      setStatus("Deleted “" + name + "” permanently.");
      state.selectedId = null;
      state.selectedSession = null;
      refreshAll();
    });
  });
  $("empty-trash-btn").addEventListener("click", function () {
    if (!window.confirm("Permanently delete everything in the trash? This cannot be undone.")) return;
    send({ type: "emptyTrash" }).then(function (r) {
      setStatus(r.error ? "Could not empty trash: " + r.error
        : "Trash emptied (" + (r.deleted || 0) + " session(s) deleted permanently).");
      state.selectedId = null;
      state.selectedSession = null;
      refreshAll();
    });
  });

  $("export-btn").addEventListener("click", function () {
    if (!state.selectedSession) return;
    send({ type: "exportSession", id: state.selectedSession.id }).then(function (r) {
      if (r.error) { setStatus("Export failed: " + r.error); return; }
      download("session-vault-" + state.selectedSession.id.slice(0, 8) + ".json", r.json);
      setStatus("Exported “" + state.selectedSession.name + "”.");
    });
  });

  $("export-text-btn").addEventListener("click", function () {
    if (!state.selectedSession) return;
    send({ type: "exportSessionText", id: state.selectedSession.id }).then(function (r) {
      if (r.error) { setStatus("Export failed: " + r.error); return; }
      download("session-vault-" + state.selectedSession.id.slice(0, 8) + ".txt", r.text, "text/plain");
      setStatus("Exported “" + state.selectedSession.name + "” as a text list.");
    });
  });

  $("export-all-btn").addEventListener("click", function () {
    send({ type: "exportAll" }).then(function (r) {
      if (r.error) { setStatus("Export failed: " + r.error); return; }
      download("session-vault-export.json", r.json);
      setStatus("Exported all sessions.");
    });
  });

  var importText = null;
  $("import-btn").addEventListener("click", function () {
    $("import-result").textContent = "";
    $("import-file").value = "";
    $("import-confirm").disabled = true;
    importText = null;
    $("import-dialog").showModal();
  });
  $("import-file").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) { $("import-confirm").disabled = true; return; }
    file.text().then(function (text) {
      importText = text;
      $("import-confirm").disabled = false;
      $("import-result").textContent = file.name + " — " + text.length + " characters, ready to import.";
    });
  });
  $("import-confirm").addEventListener("click", function () {
    if (importText == null) return;
    send({ type: "importData", text: importText, format: $("import-format").value }).then(function (r) {
      if (r.error) {
        $("import-result").textContent = "Import failed: " + r.error;
        setStatus("Import failed: " + r.error);
        return;
      }
      var msg = "Imported " + r.imported + " session(s).";
      if (r.skipped) msg += " " + r.skipped + " already in the library — skipped.";
      if (r.errors && r.errors.length) msg += " Problems: " + r.errors.join(" | ");
      $("import-result").textContent = msg;
      setStatus(msg);
      refreshAll();
    });
  });
  $("import-cancel").addEventListener("click", function () { $("import-dialog").close(); });

  $("backup-pick").addEventListener("click", pickBackupFolder);
  $("backup-dismiss").addEventListener("click", function () {
    if (HAS_EXTENSION) {
      chrome.storage.local.set({ "sv.backupWarningDismissedAt": Date.now() });
    }
    $("backup-warning").hidden = true;
  });

  async function pickBackupFolder() {
    if (!Backup.isSupported()) {
      setStatus("File System Access is not available in this browser.");
      return;
    }
    try {
      var handle = await Backup.pickFolder();
      await Idb.putMeta("backupHandle", handle);
      setStatus("Backup folder set: " + handle.name + ". Writing today's backup…");
      var result = await send({ type: "backupNow" });
      if (result.ok) {
        setStatus("Backup folder set: " + handle.name + ". Today's backup written.");
      } else {
        setStatus("Backup folder set, but the first write failed: " + (result.error || "unknown error"));
      }
      refreshAll();
    } catch (e) {
      if (e && e.name === "AbortError") {
        setStatus("Folder picker cancelled.");
      } else {
        setStatus("Could not pick a folder: " + (e && e.message ? e.message : String(e)));
      }
    }
  }

  $("integrity-verify").addEventListener("click", function () {
    setStatus("Verifying all copies…");
    send({ type: "verifyNow" }).then(function (r) {
      state.integrity = r.integrity;
      renderIntegrity();
      setStatus(r.integrity ? r.integrity.message : "Verification done.");
    });
  });

  $("recovery-restore").addEventListener("click", function () {
    setStatus("Restoring the last auto-saved snapshot…");
    send({ type: "restoreLiveSnapshot" }).then(function (r) {
      if (r.error) { setStatus("Restore failed: " + r.error); return; }
      var res = r.result;
      setStatus("Restored " + res.restored + " tab(s) from the snapshot." +
        (res.cannotOpen.length ? " " + res.cannotOpen.length + " could not be opened." : ""));
      refreshAll();
    });
  });
  $("recovery-dismiss").addEventListener("click", function () {
    send({ type: "dismissRecovery" }).then(function () {
      state.recovery = null;
      renderRecovery();
      setStatus("Recovery offer dismissed.");
    });
  });

  /* ---------- keyboard ---------- */

  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== $("search") &&
      document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "SELECT") {
      e.preventDefault();
      $("search").focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveSession("all");
    }
  });

  /* ---------- background broadcasts ---------- */

  if (HAS_EXTENSION) chrome.runtime.onMessage.addListener(function (message) {
    if (message.type === "autosaved") {
      setStatus("Auto-saved " + message.tabs + " tab(s) · " + fmtClock(message.at) + ".");
      refreshAll();
    } else if (message.type === "session-saved") {
      refreshAll();
    } else if (message.type === "backup-failed") {
      setStatus("File backup failed: " + message.error);
      refreshAll();
    }
  });

  /* ---------- preview sample data ---------- */

  /* Three realistic sessions so the public preview shows the library
   * instead of an empty page. They are clearly labelled as samples,
   * exist only in this page (never written to storage), and every
   * action that needs the extension is disabled. */
  function sampleSessions() {
    var now = Date.now();
    function tab(url, title, extra) {
      var t = { url: url, title: title, pinned: false, active: false, index: 0, groupRef: null, discarded: false };
      if (extra) Object.keys(extra).forEach(function (k) { t[k] = extra[k]; });
      return t;
    }
    function win(tabs, extra) {
      var w = { name: null, state: "normal", focused: false, incognito: false, tabs: tabs };
      if (extra) Object.keys(extra).forEach(function (k) { w[k] = extra[k]; });
      tabs.forEach(function (t, i) { t.index = i; });
      return w;
    }
    return [
      {
        id: "sample-research", name: "Morning research",
        createdAt: now - 86400000, updatedAt: now - 3600000, source: "manual",
        tags: ["work", "research"],
        windows: [
          win([
            tab("https://en.wikipedia.org/wiki/Tab_session", "Tab session — Wikipedia", { active: true }),
            tab("https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API", "IndexedDB API — MDN", { groupRef: "g1" }),
            tab("https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage", "Window: localStorage — MDN", { groupRef: "g1" }),
            tab("https://github.com/sienori/Tab-Session-Manager", "sienori/Tab-Session-Manager — GitHub", { pinned: true }),
            tab("https://news.ycombinator.com/", "Hacker News"),
          ], { focused: true }),
          win([
            tab("https://www.mozilla.org/en-US/firefox/new/", "Download Firefox", { active: true }),
            tab("https://chromewebstore.google.com/", "Chrome Web Store"),
          ]),
        ],
        groups: [{ ref: "g1", title: "Reading", color: "blue", collapsed: false }],
      },
      {
        id: "sample-trip", name: "Weekend trip planning",
        createdAt: now - 3 * 86400000, updatedAt: now - 5 * 3600000, source: "manual",
        tags: ["personal"],
        windows: [
          win([
            tab("https://www.openstreetmap.org/", "OpenStreetMap", { active: true }),
            tab("https://en.wikivoyage.org/wiki/Main_Page", "Wikivoyage — travel guide"),
            tab("https://www.nationalrail.co.uk/", "National Rail"),
          ], { focused: true }),
        ],
        groups: [],
      },
      {
        id: "sample-reading", name: "Reading list — articles",
        createdAt: now - 6 * 86400000, updatedAt: now - 26 * 3600000, source: "auto",
        tags: ["reading"],
        windows: [
          win([
            tab("https://en.wikipedia.org/wiki/History_of_the_web_browser", "History of the web browser — Wikipedia", { active: true }),
            tab("https://www.w3.org/TR/IndexedDB/", "IndexedDB — W3C"),
            tab("https://developer.chrome.com/docs/extensions/reference/api/tabs", "chrome.tabs API — Chrome Developers"),
            tab("https://web.dev/articles/", "Articles — web.dev"),
          ], { focused: true }),
        ],
        groups: [],
      },
    ];
  }

  function sampleIndexEntry(s) {
    var titles = [];
    var urls = [];
    s.windows.forEach(function (w) {
      w.tabs.forEach(function (t) {
        if (t.title) titles.push(t.title);
        if (t.url) urls.push(t.url);
      });
    });
    return {
      id: s.id, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt,
      source: s.source, tags: s.tags || [], trashedAt: null,
      windowCount: SessionStore.countWindows(s), tabCount: SessionStore.countTabs(s),
      titles: titles, urls: urls,
    };
  }

  /* ---------- boot ---------- */

  /* Preview mode: the page is served on the open web without the
   * extension. Show a notice, resolve the badge to "Preview" instead
   * of leaving it on "Checking…", load the sample sessions, and
   * disable every action that needs the extension. Local UI (search,
   * sort, tag filter, view tabs, dialogs) keeps working. */
  function enterPreviewMode() {
    $("preview-banner").hidden = false;
    $("sample-banner").hidden = false;
    var badge = $("integrity-badge");
    badge.className = "badge badge-unknown";
    badge.textContent = "Preview";
    badge.title = "Preview of the library — install the extension to use it.";
    $("backup-status").textContent = "Backup: not set";
    ["save-window", "save-all", "empty-save", "export-all-btn", "import-btn",
      "restore-btn", "restore-selected-btn", "rename-btn", "export-btn",
      "export-text-btn", "delete-btn", "trash-restore-btn", "trash-delete-btn",
      "empty-trash-btn", "recovery-restore", "recovery-dismiss",
      "integrity-verify", "backup-pick"].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = true;
    });
    var samples = sampleSessions();
    state.samples = {};
    samples.forEach(function (s) { state.samples[s.id] = s; });
    state.index = samples.map(sampleIndexEntry);
    renderTagFilter();
    renderList();
    // Open the first sample so the page shows the library at work
    // instead of an empty pane next to a full list.
    if (samples.length) selectSession(samples[0].id, false);
    setStatus("Preview — install the Session Vault extension to save and restore sessions.");
  }

  if (!HAS_EXTENSION) {
    enterPreviewMode();
  } else {
    send({ type: "verifyNow" }).then(function (r) {
      state.integrity = r.integrity;
      return refreshAll();
    }).then(function () {
      setStatus("Ready.");
    });
  }
})();
