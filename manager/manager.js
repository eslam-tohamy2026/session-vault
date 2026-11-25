/* Session Vault — manager page logic.
 * The manager is a view: all storage lives in the service worker.
 * The one thing the manager does itself is the backup folder: the
 * File System Access picker needs a window and a user gesture, so it
 * can never run in the worker. The directory handle is stored in
 * IndexedDB (meta store) for the worker to reuse.
 */

(function () {
  "use strict";

  var SessionStore = window.SessionStore;
  var Idb = window.SessionVaultIdb;
  var Backup = window.SessionVaultBackup;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    index: [],
    trash: [],
    closed: [],
    view: "sessions",
    selectedId: null,
    selectedSession: null,
    search: "",
    integrity: null,
    recovery: null,
    backup: null,
  };

  function send(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        resolve(response || {});
      });
    });
  }

  function setStatus(text) {
    $("status").textContent = text;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleString([], {
      day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: "application/json" });
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
    if (!q) return state.index;
    return state.index.filter(function (entry) {
      if (entry.name.toLowerCase().indexOf(q) !== -1) return true;
      return (entry.titles || []).some(function (t) { return t.toLowerCase().indexOf(q) !== -1; }) ||
        (entry.urls || []).some(function (u) { return u.toLowerCase().indexOf(q) !== -1; });
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
        };
      });
    } else if (state.view === "trash") {
      items = state.trash.map(function (entry) {
        return {
          key: entry.id, title: entry.name,
          meta: "Deleted " + fmtTime(entry.trashedAt || entry.updatedAt) +
            " · " + entry.windowCount + " window(s) · " + entry.tabCount + " tab(s)",
          badge: "Trash", badgeClass: "",
        };
      });
    } else {
      items = state.closed.map(function (c, i) {
        var label = c.tab ? (c.tab.title || c.tab.url || "Tab")
          : c.window ? (c.window.tabs ? c.window.tabs.length + " tabs" : "Window") : "Closed item";
        return {
          key: "closed-" + i, title: label,
          meta: fmtTime(c.lastModified * 1000),
          badge: c.tab ? "Tab" : "Window", badgeClass: "",
          closed: c,
        };
      });
    }

    if (!items.length) {
      var li = document.createElement("li");
      li.textContent = state.view === "sessions"
        ? (state.search ? "No sessions match that search." : "No saved sessions yet.")
        : state.view === "trash"
          ? "Trash is empty."
          : "Nothing recently closed.";
      li.style.cursor = "default";
      list.appendChild(li);
    }
    items.forEach(function (item) {
      var li = document.createElement("li");
      if (item.key === state.selectedId) li.classList.add("selected");
      li.innerHTML = "<div class=\"name\">" + escapeHtml(item.title) +
        "<span class=\"source-badge " + item.badgeClass + "\">" + escapeHtml(item.badge) + "</span></div>" +
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
    var totalTabs = state.index.reduce(function (n, e) { return n + e.tabCount; }, 0);
    $("counts").textContent = state.index.length + " session(s) · " + totalTabs + " tab(s) saved";
  }

  /* ---------- session detail ---------- */

  function renderDetail() {
    var s = state.selectedSession;
    $("empty-state").hidden = !!s;
    $("session-detail").hidden = !s;
    if (!s) return;
    $("detail-name").textContent = s.name;
    var tabs = SessionStore.countTabs(s);
    $("detail-meta").textContent = fmtTime(s.updatedAt) + " · " +
      SessionStore.countWindows(s) + " window(s) · " + tabs + " tab(s) · " +
      (s.source === "manual" ? "Saved manually" : s.source === "crash" ? "Recovered after a crash" : "Auto-saved");
    $("restore-hint").textContent = "Restores " + tabs + " tab(s) in " +
      SessionStore.countWindows(s) + " window(s). Tabs open unloaded by default.";
    var wrap = $("detail-windows");
    wrap.innerHTML = "";
    var groupByRef = {};
    (s.groups || []).forEach(function (g) { groupByRef[g.ref] = g; });
    s.windows.forEach(function (w, wi) {
      var block = document.createElement("div");
      block.className = "window-block";
      var pinnedCount = w.tabs.filter(function (t) { return t.pinned; }).length;
      block.innerHTML = "<h3>Window " + (wi + 1) +
        (w.focused ? " · focused" : "") +
        (w.incognito ? " · incognito" : "") +
        (w.state && w.state !== "normal" ? " · " + escapeHtml(w.state) : "") +
        (pinnedCount ? " · <span class=\"pinned-note\">" + pinnedCount + " pinned</span>" : "") +
        "</h3>";
      var ul = document.createElement("ul");
      ul.className = "tab-list";
      w.tabs.forEach(function (t) {
        var li = document.createElement("li");
        var group = t.groupRef ? groupByRef[t.groupRef] : null;
        li.innerHTML =
          (t.pinned ? "<span class=\"tab-pin\">PINNED</span>" : "") +
          (group ? "<span class=\"group-chip " + escapeHtml(group.color) + "\">" +
            escapeHtml(group.title || "Group") + "</span>" : "") +
          "<span class=\"tab-title\">" + escapeHtml(t.title || "(no title)") + "</span>" +
          "<span class=\"tab-url\">" + escapeHtml(t.url || "(empty tab)") + "</span>";
        ul.appendChild(li);
      });
      block.appendChild(ul);
      wrap.appendChild(block);
    });
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
      renderList();
      renderDetail();
    });
  }

  function selectSession(id, fromTrash) {
    state.selectedId = id;
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

  function openRestoreDialog() {
    var s = state.selectedSession;
    if (!s) return;
    send({ type: "previewRestore", id: s.id }).then(function (r) {
      if (r.error) { setStatus("Could not preview restore: " + r.error); return; }
      var tabs = SessionStore.countTabs(s);
      $("restore-summary").textContent = "“" + s.name + "” — " + tabs + " tab(s) in " +
        SessionStore.countWindows(s) + " window(s).";
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
    if (!s) return;
    var options = {
      target: $("restore-target").value,
      skipDuplicates: $("restore-skip-dupes").checked,
      unloaded: $("restore-unloaded").checked,
    };
    setStatus("Restoring “" + s.name + "”…");
    send({ type: "restoreSession", id: s.id, options: options }).then(function (r) {
      if (r.error) { setStatus("Restore failed: " + r.error); return; }
      var res = r.result;
      var parts = ["Restored " + res.restored + " tab(s)"];
      if (res.skipped) parts.push(res.skipped + " already open — skipped");
      if (res.cannotOpen.length) parts.push(res.cannotOpen.length + " could not be opened");
      if (res.leftLoaded.length) parts.push(res.leftLoaded.length + " left loaded (never finished loading)");
      setStatus(parts.join(" · ") + ".");
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

  function setView(view) {
    state.view = view;
    state.selectedId = null;
    state.selectedSession = null;
    ["sessions", "trash", "closed"].forEach(function (v) {
      $("view-" + v).classList.toggle("active", v === view);
    });
    if (view === "trash") {
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

  $("restore-btn").addEventListener("click", openRestoreDialog);
  $("restore-confirm").addEventListener("click", function () { doRestore(); });

  $("rename-btn").addEventListener("click", function () {
    if (!state.selectedSession) return;
    $("rename-input").value = state.selectedSession.name;
    $("rename-dialog").showModal();
  });
  $("rename-confirm").addEventListener("click", function () {
    var name = $("rename-input").value.trim();
    if (!name || !state.selectedSession) return;
    send({ type: "renameSession", id: state.selectedSession.id, name: name }).then(function (r) {
      if (r.error) { setStatus("Rename failed: " + r.error); return; }
      state.selectedSession = r.session;
      setStatus("Renamed to “" + name + "”.");
      refreshAll();
    });
  });

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

  $("export-btn").addEventListener("click", function () {
    if (!state.selectedSession) return;
    send({ type: "exportSession", id: state.selectedSession.id }).then(function (r) {
      if (r.error) { setStatus("Export failed: " + r.error); return; }
      download("session-vault-" + state.selectedSession.id.slice(0, 8) + ".json", r.json);
      setStatus("Exported “" + state.selectedSession.name + "”.");
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
      var msg = "Imported " + r.imported + " session(s).";
      if (r.errors && r.errors.length) msg += " Problems: " + r.errors.join(" | ");
      $("import-result").textContent = msg;
      setStatus(msg);
      refreshAll();
    });
  });

  $("backup-pick").addEventListener("click", pickBackupFolder);
  $("backup-dismiss").addEventListener("click", function () {
    chrome.storage.local.set({ "sv.backupWarningDismissedAt": Date.now() });
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
      var exported = await send({ type: "exportAll" });
      var result = await Backup.writeDailyBackup(handle, exported.json, new Date());
      if (result.ok) {
        await send({ type: "backupNow" });
        setStatus("Backup folder set: " + handle.name + ". Today's backup written.");
      } else {
        setStatus("Backup folder set, but the first write failed: " + result.error);
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

  chrome.runtime.onMessage.addListener(function (message) {
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

  /* ---------- boot ---------- */

  send({ type: "verifyNow" }).then(function (r) {
    state.integrity = r.integrity;
    return refreshAll();
  }).then(function () {
    setStatus("Ready.");
  });
})();
