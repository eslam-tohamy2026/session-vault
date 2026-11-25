/* Session Vault — popup logic. Two one-click saves, the way into the
 * manager, and the last auto-save time. */

(function () {
  "use strict";

  var statusEl = document.getElementById("status");
  var lastEl = document.getElementById("last-autosave");
  var integrityEl = document.getElementById("integrity");
  var saveWindowBtn = document.getElementById("save-window");
  var saveAllBtn = document.getElementById("save-all");
  var openBtn = document.getElementById("open-manager");

  function send(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        resolve(response || {});
      });
    });
  }

  function timeAgo(ts) {
    if (!ts) return "Auto-save is running — nothing saved yet.";
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "Auto-saved " + s + "s ago.";
    if (s < 3600) return "Auto-saved " + Math.round(s / 60) + " min ago.";
    return "Auto-saved " + new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ".";
  }

  function refresh() {
    send({ type: "getLastAutosave" }).then(function (r) {
      lastEl.textContent = timeAgo(r.at);
    });
    send({ type: "getIntegrity" }).then(function (r) {
      var i = r.integrity;
      if (!i) { integrityEl.textContent = "No auto-save yet."; return; }
      integrityEl.textContent = i.status === "ok"
        ? "All copies verified."
        : i.status === "healed"
          ? "Recovered from the backup copy — your sessions are safe."
          : i.message || "Integrity check pending.";
    });
  }

  function save(scope, btn) {
    btn.disabled = true;
    statusEl.textContent = "Saving…";
    send({ type: "saveSession", scope: scope }).then(function (r) {
      btn.disabled = false;
      if (r.error) {
        statusEl.textContent = "Could not save: " + r.error;
        return;
      }
      var count = r.session.windows.reduce(function (n, w) { return n + w.tabs.length; }, 0);
      statusEl.textContent = "Saved “" + r.session.name + "” — " +
        r.session.windows.length + " window(s), " + count + " tab(s).";
      refresh();
    });
  }

  saveWindowBtn.addEventListener("click", function () { save("window", saveWindowBtn); });
  saveAllBtn.addEventListener("click", function () { save("all", saveAllBtn); });
  openBtn.addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("manager/index.html") });
    window.close();
  });

  refresh();
})();
