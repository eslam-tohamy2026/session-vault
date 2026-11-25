/* Session Vault — copy 3: the dated JSON file outside the browser
 * profile, written through the File System Access API.
 *
 * The folder is picked once by the user (one gesture, from the manager
 * page — showDirectoryPicker needs a window and a user gesture, so it
 * can never be called from the service worker). The directory handle
 * is stored in IndexedDB (meta store) for reuse.
 *
 * Writing with a stored handle CAN run from the service worker: the
 * handle is structured-cloneable and createWritable works there. If
 * the permission was revoked, the write throws and the caller records
 * the failure — the manager page then asks the user to pick the folder
 * again. A failed file backup never fails a save.
 *
 * Pure helpers (dailyBackupName, manualBackupName) are exported for
 * tests; everything else is browser-only.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SessionVaultBackup = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function dateStamp(date) {
    var d = date instanceof Date ? date : new Date(date);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function timeStamp(date) {
    var d = date instanceof Date ? date : new Date(date);
    return pad(d.getHours()) + pad(d.getMinutes());
  }

  /* One file per day: session-vault-2026-11-25.json */
  function dailyBackupName(date) {
    return "session-vault-" + dateStamp(date) + ".json";
  }

  /* One file per manual save: session-vault-manual-<slug>-<HHMM>.json */
  function manualBackupName(name, date) {
    var slug = String(name || "session").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
    return "session-vault-manual-" + slug + "-" + timeStamp(date) + ".json";
  }

  function isSupported() {
    return typeof window !== "undefined" &&
      typeof window.showDirectoryPicker === "function";
  }

  /* One user gesture, from the manager page. Returns the directory
   * handle (the caller stores it in the meta store). */
  async function pickFolder() {
    if (!isSupported()) {
      throw new Error("File System Access is not available in this browser");
    }
    return window.showDirectoryPicker({ id: "session-vault", mode: "readwrite" });
  }

  /* Ask Chrome to (re)grant access to a stored handle. Returns true
   * when the handle is usable, false when the user must pick again. */
  async function ensurePermission(handle) {
    if (!handle) return false;
    try {
      var opts = { mode: "readwrite" };
      if (typeof handle.queryPermission === "function") {
        if ((await handle.queryPermission(opts)) === "granted") return true;
      }
      if (typeof handle.requestPermission === "function") {
        return (await handle.requestPermission(opts)) === "granted";
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Atomic write: createWritable with keepExistingData: false replaces
   * the file in one go, so a crashed write leaves the previous day's
   * file untouched rather than a half-written one. */
  async function writeFile(handle, filename, text) {
    var fileHandle = await handle.getFileHandle(filename, { create: true });
    var writable = await fileHandle.createWritable({ keepExistingData: false });
    try {
      await writable.write(text);
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch (ignored) { /* already closed */ }
      throw e;
    }
    return filename;
  }

  /* Write the daily backup. Returns { ok, filename } or
   * { ok: false, error } — the caller records the result, never throws
   * into a save. */
  async function writeDailyBackup(handle, jsonText, date) {
    if (!handle) return { ok: false, error: "no backup folder chosen" };
    try {
      var filename = await writeFile(handle, dailyBackupName(date), jsonText);
      return { ok: true, filename: filename };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  async function writeManualBackup(handle, name, jsonText, date) {
    if (!handle) return { ok: false, error: "no backup folder chosen" };
    try {
      var filename = await writeFile(handle, manualBackupName(name, date), jsonText);
      return { ok: true, filename: filename };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /* Read a backup file the user picks (restore-from-file). The manager
   * page hands over a File object from an <input type="file">. */
  async function readBackupFile(file) {
    return file.text();
  }

  return {
    dateStamp: dateStamp,
    dailyBackupName: dailyBackupName,
    manualBackupName: manualBackupName,
    isSupported: isSupported,
    pickFolder: pickFolder,
    ensurePermission: ensurePermission,
    writeFile: writeFile,
    writeDailyBackup: writeDailyBackup,
    writeManualBackup: writeManualBackup,
    readBackupFile: readBackupFile,
  };
});
