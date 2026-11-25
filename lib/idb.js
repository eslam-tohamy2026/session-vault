/* Session Vault — tiny promise wrapper around raw IndexedDB.
 *
 * No library: the `idb` wrapper would be ~1 KB of code to vendor and
 * audit anyway; raw IndexedDB with a small promise helper is smaller
 * and fully ours. Every write is one transaction with an explicit
 * oncomplete / onabort handler — a write that aborts is reported,
 * never assumed.
 *
 * Object stores:
 *   sessions — one record per saved session (key: id), plus the live
 *              auto-save snapshot (id "__live__") and the last 10
 *              auto-save generations (ids "__live-N__").
 *   meta     — key/value rows: "schemaVersion", "backupHandle"
 *              (the File System Access directory handle), "settings".
 *
 * Browser-only (indexedDB does not exist in Node), but requiring this
 * file in Node is safe: indexedDB is only touched when a function is
 * called. Loaded as a classic script in the extension; UMD for tests.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SessionVaultIdb = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  var DB_NAME = "session-vault";
  var DB_VERSION = 1;
  var LIVE_ID = "__live__";

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB open failed")); };
      req.onblocked = function () { reject(new Error("IndexedDB open blocked — another tab holds the database")); };
    });
    return dbPromise;
  }

  /* Run a function inside one transaction and resolve only when the
   * transaction commits. A transaction that aborts rejects — the
   * caller must never assume a write landed. */
  function transact(storeNames, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(storeNames, mode);
        } catch (e) {
          reject(e);
          return;
        }
        var done = false;
        tx.oncomplete = function () {
          if (!done) { done = true; resolve(); }
        };
        tx.onabort = function () {
          if (!done) { done = true; reject(tx.error || new Error("IndexedDB transaction aborted")); }
        };
        tx.onerror = function () {
          if (!done) { done = true; reject(tx.error || new Error("IndexedDB transaction failed")); }
        };
        var result;
        try {
          result = fn(tx);
        } catch (e) {
          if (!done) { done = true; reject(e); }
          return;
        }
        // If the work returned a promise (e.g. a get), wait for it too
        // before resolving — but the transaction's oncomplete is still
        // the authority on whether the write committed.
        if (result && typeof result.then === "function") {
          result.then(function (value) {
            if (!done) { done = true; resolve(value); }
          }, function (e) {
            if (!done) { done = true; reject(e); }
          });
        }
      });
    });
  }

  function requestToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB request failed")); };
    });
  }

  function putSession(session) {
    return transact(["sessions"], "readwrite", function (tx) {
      return requestToPromise(tx.objectStore("sessions").put(session));
    });
  }

  function getSession(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(["sessions"], "readonly");
        var req = tx.objectStore("sessions").get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error || new Error("IndexedDB get failed")); };
      });
    });
  }

  function deleteSession(id) {
    return transact(["sessions"], "readwrite", function (tx) {
      return requestToPromise(tx.objectStore("sessions").delete(id));
    });
  }

  function listSessions() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(["sessions"], "readonly");
        var req = tx.objectStore("sessions").getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error || new Error("IndexedDB list failed")); };
      });
    });
  }

  function putMeta(key, value) {
    return transact(["meta"], "readwrite", function (tx) {
      return requestToPromise(tx.objectStore("meta").put({ key: key, value: value }));
    });
  }

  function getMeta(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(["meta"], "readonly");
        var req = tx.objectStore("meta").get(key);
        req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
        req.onerror = function () { reject(req.error || new Error("IndexedDB get failed")); };
      });
    });
  }

  function deleteMeta(key) {
    return transact(["meta"], "readwrite", function (tx) {
      return requestToPromise(tx.objectStore("meta").delete(key));
    });
  }

  return {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    LIVE_ID: LIVE_ID,
    openDb: openDb,
    transact: transact,
    putSession: putSession,
    getSession: getSession,
    deleteSession: deleteSession,
    listSessions: listSessions,
    putMeta: putMeta,
    getMeta: getMeta,
    deleteMeta: deleteMeta,
  };
});
