/* Session Vault — pure session model functions.
 *
 * No chrome.* calls, no network, no browser globals: the SAME file runs
 * in the extension (as a classic script) and in Node for tests
 * (UMD-style, as in the PDF Toolbox and Maker File Previewer).
 *
 * Everything that touches Chrome APIs lives in background.js,
 * lib/restore.js and lib/backup.js. This file only answers questions
 * about data: what a session is, whether two snapshots match, whether
 * a stored copy is intact, and how to turn foreign formats into ours.
 *
 * Data model (schema v1, versioned in every stored file):
 *   Session {
 *     id, name, createdAt, updatedAt,
 *     source: "manual" | "auto" | "crash",
 *     windows: [ { name, state, focused, incognito,
 *                  tabs: [ { url, title, pinned, active, index,
 *                            groupRef, discarded } ] } ],
 *     groups: [ { ref, title, color, collapsed } ]
 *   }
 * A tab group is stored by REFERENCE (title + colour + tab list), never
 * by group id: group ids are unique per browser session and are reused
 * after a group is gone, so persisting one would restore the wrong
 * group. Window names are stored when the platform reports one; Chrome
 * currently does not expose window names to extensions, so the field
 * is null in practice and the UI never promises name restore.
 *
 * What is deliberately NOT stored: tab history (Chrome cannot restore
 * another tab's history), scroll position, form contents.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SessionStore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  var SCHEMA_VERSION = 1;

  var GROUP_COLORS = [
    "grey", "blue", "red", "yellow", "green",
    "pink", "purple", "cyan", "orange",
  ];

  /* A URL an extension can open with chrome.tabs.create. chrome://,
   * chrome-extension:// and about: pages cannot be created by an
   * extension; file:// needs the user's "Allow access to file URLs"
   * toggle. An empty tab (new-tab page, no URL yet) has nothing to
   * restore. These are collected, not fatal, at restore time. */
  var NON_OPENABLE_SCHEMES = ["chrome:", "chrome-extension:", "about:", "file:", "view-source:", "devtools:"];

  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "sv-" + Date.now().toString(36) + "-" +
      Math.floor(Math.random() * 0xffffff).toString(16);
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  /* Normalise a URL for duplicate detection: lowercase scheme and
   * host, drop the fragment, drop a trailing slash on a non-root path.
   * Returns null for anything that is not a usable web URL. */
  function normaliseUrl(url) {
    if (typeof url !== "string") return null;
    var u = url.trim();
    if (!u) return null;
    var lower = u.toLowerCase();
    if (lower.indexOf("http://") !== 0 && lower.indexOf("https://") !== 0) {
      return null;
    }
    var hash = u.indexOf("#");
    if (hash !== -1) u = u.slice(0, hash);
    var schemeEnd = u.indexOf("://") + 3;
    var rest = u.slice(schemeEnd);
    var slash = rest.indexOf("/");
    var host = slash === -1 ? rest : rest.slice(0, slash);
    var path = slash === -1 ? "" : rest.slice(slash);
    if (path.length > 1 && path.charAt(path.length - 1) === "/") {
      path = path.slice(0, -1);
    }
    return u.slice(0, schemeEnd) + host.toLowerCase() + path;
  }

  /* Why a tab cannot be opened by the restore engine, or null when it
   * can. Kept separate from normaliseUrl so the UI can explain it. */
  function cannotOpenReason(url) {
    if (typeof url !== "string" || !url.trim()) {
      return "empty tab — nothing to restore";
    }
    var lower = url.trim().toLowerCase();
    for (var i = 0; i < NON_OPENABLE_SCHEMES.length; i++) {
      if (lower.indexOf(NON_OPENABLE_SCHEMES[i]) === 0) {
        if (NON_OPENABLE_SCHEMES[i] === "file:") {
          return "file:// URL — needs \"Allow access to file URLs\" turned on for Session Vault";
        }
        return "browser page — extensions cannot open " + NON_OPENABLE_SCHEMES[i] + " pages";
      }
    }
    if (lower.indexOf("http://") !== 0 && lower.indexOf("https://") !== 0) {
      return "unsupported address";
    }
    return null;
  }

  function groupRefFor(index) {
    return "g" + (index + 1);
  }

  /* Turn raw chrome.windows / chrome.tabs / chrome.tabGroups rows into
   * a normalised session. `windows` is an array of window objects,
   * `tabs` an array of tab objects, `groups` an array of group objects
   * (all three as Chrome returns them). Tabs are sorted by index inside
   * each window; groups are stored by reference, in first-use order. */
  function capture(windows, tabs, groups, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    var groupById = {};
    var groupList = [];
    (groups || []).forEach(function (g) {
      if (g == null || g.id == null) return;
      var ref = groupRefFor(groupList.length);
      groupById[g.id] = ref;
      groupList.push({
        ref: ref,
        title: typeof g.title === "string" ? g.title : "",
        color: GROUP_COLORS.indexOf(g.color) !== -1 ? g.color : "grey",
        collapsed: !!g.collapsed,
      });
    });

    var tabsByWindow = {};
    (tabs || []).forEach(function (t) {
      if (t == null || t.windowId == null) return;
      if (!tabsByWindow[t.windowId]) tabsByWindow[t.windowId] = [];
      tabsByWindow[t.windowId].push(t);
    });

    var outWindows = (windows || []).map(function (w) {
      var wTabs = (tabsByWindow[w.id] || []).slice().sort(function (a, b) {
        return (a.index || 0) - (b.index || 0);
      });
      return {
        name: typeof w.name === "string" ? w.name : null,
        state: typeof w.state === "string" ? w.state : "normal",
        focused: !!w.focused,
        incognito: !!w.incognito,
        tabs: wTabs.map(function (t, i) {
          return {
            url: typeof t.url === "string" ? t.url : "",
            title: typeof t.title === "string" ? t.title : "",
            pinned: !!t.pinned,
            active: !!t.active,
            index: i,
            groupRef: t.groupId != null && t.groupId !== -1 && groupById[t.groupId]
              ? groupById[t.groupId]
              : null,
            discarded: !!t.discarded,
          };
        }),
      };
    });

    var session = {
      id: opts.id || newId(),
      name: opts.name || "",
      createdAt: opts.createdAt != null ? opts.createdAt : now,
      updatedAt: now,
      source: opts.source || "auto",
      windows: outWindows,
      groups: groupList,
    };
    if (!session.name) session.name = defaultSessionName(session, now);
    return session;
  }

  function defaultSessionName(session, now) {
    var d = new Date(now != null ? now : Date.now());
    var date = d.toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
    var time = d.toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit",
    });
    var firstTitles = [];
    (session.windows || []).forEach(function (w) {
      (w.tabs || []).forEach(function (t) {
        if (t.title && firstTitles.length < 2) firstTitles.push(t.title);
      });
    });
    var suffix = firstTitles.length ? " — " + firstTitles.join(", ") : "";
    return date + ", " + time + suffix;
  }

  function countTabs(session) {
    var n = 0;
    (session.windows || []).forEach(function (w) {
      n += (w.tabs || []).length;
    });
    return n;
  }

  function countWindows(session) {
    return (session.windows || []).length;
  }

  /* Split a tab list into the tabs to keep and the duplicates, by
   * normalised URL. The first occurrence of a URL is kept. */
  function dedupeTabs(tabs) {
    var seen = {};
    var kept = [];
    var duplicates = [];
    (tabs || []).forEach(function (t) {
      var key = normaliseUrl(t.url);
      if (key && seen[key]) {
        duplicates.push(t);
      } else {
        if (key) seen[key] = true;
        kept.push(t);
      }
    });
    return { tabs: kept, duplicates: duplicates };
  }

  /* Plan a restore without touching Chrome: for every tab in the
   * session, decide whether it opens, is skipped as a duplicate of a
   * tab already open, or cannot be opened at all (with the reason).
   * `openUrls` is the list of URLs currently open anywhere.
   * Returns the plan plus counts the confirmation dialog shows. */
  function planRestore(session, openUrls, opts) {
    opts = opts || {};
    var skipDuplicates = opts.skipDuplicates !== false;
    var openSet = {};
    (openUrls || []).forEach(function (u) {
      var key = normaliseUrl(u);
      if (key) openSet[key] = true;
    });
    var plan = { windows: [], groups: session.groups || [], toOpen: 0, skipped: 0, cannotOpen: [] };
    (session.windows || []).forEach(function (w) {
      var pw = {
        name: w.name, state: w.state, focused: w.focused,
        incognito: w.incognito, tabs: [],
      };
      (w.tabs || []).forEach(function (t) {
        var reason = cannotOpenReason(t.url);
        if (reason) {
          plan.cannotOpen.push({ url: t.url, title: t.title, reason: reason });
          pw.tabs.push({ tab: t, action: "cannot-open", reason: reason });
          return;
        }
        var key = normaliseUrl(t.url);
        if (skipDuplicates && key && openSet[key]) {
          plan.skipped += 1;
          pw.tabs.push({ tab: t, action: "skip-duplicate" });
          return;
        }
        plan.toOpen += 1;
        pw.tabs.push({ tab: t, action: "open" });
      });
      plan.windows.push(pw);
    });
    return plan;
  }

  /* Compare a saved snapshot with the browser state right now (both as
   * sessions, e.g. the live auto-save vs a fresh capture). Used by the
   * crash-recovery check on startup. */
  function diffSnapshots(saved, current) {
    var savedUrls = {};
    var currentUrls = {};
    (saved.windows || []).forEach(function (w) {
      (w.tabs || []).forEach(function (t) {
        var key = normaliseUrl(t.url);
        if (key) savedUrls[key] = (savedUrls[key] || 0) + 1;
      });
    });
    (current.windows || []).forEach(function (w) {
      (w.tabs || []).forEach(function (t) {
        var key = normaliseUrl(t.url);
        if (key) currentUrls[key] = (currentUrls[key] || 0) + 1;
      });
    });
    var missing = [];
    var extra = [];
    Object.keys(savedUrls).forEach(function (u) {
      var diff = savedUrls[u] - (currentUrls[u] || 0);
      for (var i = 0; i < diff; i++) missing.push(u);
    });
    Object.keys(currentUrls).forEach(function (u) {
      var diff = currentUrls[u] - (savedUrls[u] || 0);
      for (var i = 0; i < diff; i++) extra.push(u);
    });
    return {
      missingTabs: missing,
      extraTabs: extra,
      missingCount: missing.length,
      savedTabCount: countTabs(saved),
      currentTabCount: countTabs(current),
      isRecovery: missing.length > 0,
    };
  }

  /* Canonical JSON: object keys sorted recursively, so the same session
   * always hashes to the same string. */
  function canonicalJson(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map(canonicalJson).join(",") + "]";
    }
    var keys = Object.keys(value).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + canonicalJson(value[k]);
    }).join(",") + "}";
  }

  /* SHA-256 hex of a session's canonical JSON. `digest` is injected:
   * in the extension it wraps crypto.subtle.digest, in tests Node's
   * crypto. The core stays dependency-free and testable. */
  async function checksum(session, digest) {
    var bytes = new TextEncoder().encode(canonicalJson(session));
    return digest(bytes);
  }

  function makeEnvelope(session, sha256Hex) {
    return {
      schemaVersion: SCHEMA_VERSION,
      savedAt: Date.now(),
      tabCount: countTabs(session),
      windowCount: countWindows(session),
      sha256: sha256Hex,
      session: session,
    };
  }

  async function verifyEnvelope(envelope, digest) {
    if (!isPlainObject(envelope) || !isPlainObject(envelope.session)) return false;
    if (envelope.schemaVersion !== SCHEMA_VERSION) return false;
    if (typeof envelope.sha256 !== "string") return false;
    var actual = await checksum(envelope.session, digest);
    return actual === envelope.sha256;
  }

  /* Rotate the mirror pair: the new envelope becomes current, the old
   * current becomes previous. Pure — the caller writes the new current
   * slot first, verifies it reads back, and only then rotates, so a
   * torn write can only ever damage the slot being written. */
  function rotateSlots(slots, newEnvelope) {
    return {
      current: newEnvelope,
      previous: slots && slots.current ? slots.current : null,
    };
  }

  /* Self-healing read of the mirror pair. Verifies current first,
   * then previous. Returns { envelope, source, healed, damaged }:
   * source is "current", "previous" or null; healed is true when the
   * good copy was not the current one. A damaged current slot is never
   * trusted, and an empty mirror reports null rather than inventing
   * data. */
  async function healSlots(slots, digest) {
    var current = slots && slots.current ? slots.current : null;
    var previous = slots && slots.previous ? slots.previous : null;
    if (current && (await verifyEnvelope(current, digest))) {
      return { envelope: current, source: "current", healed: false, damaged: false };
    }
    if (previous && (await verifyEnvelope(previous, digest))) {
      return { envelope: previous, source: "previous", healed: true, damaged: true };
    }
    return {
      envelope: null,
      source: null,
      healed: false,
      damaged: !!(current || previous),
    };
  }

  /* Schema validation for imports. Returns { ok, errors } with one
   * specific error per problem, never a throw — a corrupt file is
   * reported, not crashed on. */
  function validateSession(obj) {
    var errors = [];
    if (!isPlainObject(obj)) return { ok: false, errors: ["session is not an object"] };
    if (obj.schemaVersion != null && obj.schemaVersion !== SCHEMA_VERSION) {
      errors.push("unsupported schemaVersion " + obj.schemaVersion + " (expected " + SCHEMA_VERSION + ")");
    }
    if (typeof obj.id !== "string" || !obj.id) errors.push("missing id");
    if (typeof obj.name !== "string") errors.push("missing name");
    if (!Array.isArray(obj.windows)) {
      errors.push("windows is not an array");
    } else {
      obj.windows.forEach(function (w, wi) {
        if (!isPlainObject(w)) { errors.push("windows[" + wi + "] is not an object"); return; }
        if (!Array.isArray(w.tabs)) { errors.push("windows[" + wi + "].tabs is not an array"); return; }
        w.tabs.forEach(function (t, ti) {
          var at = "windows[" + wi + "].tabs[" + ti + "]";
          if (!isPlainObject(t)) { errors.push(at + " is not an object"); return; }
          if (typeof t.url !== "string") errors.push(at + ".url is not a string");
          if (typeof t.title !== "string") errors.push(at + ".title is not a string");
          if (typeof t.pinned !== "boolean") errors.push(at + ".pinned is not a boolean");
          if (typeof t.active !== "boolean") errors.push(at + ".active is not a boolean");
        });
      });
    }
    if (obj.groups != null && !Array.isArray(obj.groups)) {
      errors.push("groups is not an array");
    } else if (Array.isArray(obj.groups)) {
      obj.groups.forEach(function (g, gi) {
        if (!isPlainObject(g)) { errors.push("groups[" + gi + "] is not an object"); return; }
        if (typeof g.ref !== "string") errors.push("groups[" + gi + "].ref is not a string");
        if (typeof g.title !== "string") errors.push("groups[" + gi + "].title is not a string");
        if (typeof g.color !== "string") errors.push("groups[" + gi + "].color is not a string");
        if (typeof g.collapsed !== "boolean") errors.push("groups[" + gi + "].collapsed is not a boolean");
      });
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /* Normalise a parsed session object into our shape, filling
   * defaults and dropping unknown fields. Used by import. */
  function normaliseImported(obj) {
    var now = Date.now();
    var session = {
      id: typeof obj.id === "string" && obj.id ? obj.id : newId(),
      name: typeof obj.name === "string" && obj.name ? obj.name : "",
      createdAt: typeof obj.createdAt === "number" ? obj.createdAt : now,
      updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : now,
      source: obj.source === "manual" || obj.source === "crash" ? obj.source : "auto",
      windows: [],
      groups: [],
    };
    (obj.windows || []).forEach(function (w) {
      session.windows.push({
        name: typeof w.name === "string" ? w.name : null,
        state: typeof w.state === "string" ? w.state : "normal",
        focused: !!w.focused,
        incognito: !!w.incognito,
        tabs: (w.tabs || []).map(function (t, i) {
          return {
            url: typeof t.url === "string" ? t.url : "",
            title: typeof t.title === "string" ? t.title : "",
            pinned: !!t.pinned,
            active: !!t.active,
            index: i,
            groupRef: typeof t.groupRef === "string" ? t.groupRef : null,
            discarded: !!t.discarded,
          };
        }),
      });
    });
    (obj.groups || []).forEach(function (g) {
      session.groups.push({
        ref: typeof g.ref === "string" ? g.ref : groupRefFor(session.groups.length),
        title: typeof g.title === "string" ? g.title : "",
        color: GROUP_COLORS.indexOf(g.color) !== -1 ? g.color : "grey",
        collapsed: !!g.collapsed,
      });
    });
    if (!session.name) session.name = defaultSessionName(session, now);
    return session;
  }

  /* Export one or more sessions plus (optionally) the live snapshot,
   * in the documented, versioned format. */
  function exportJson(sessions, opts) {
    opts = opts || {};
    var doc = {
      format: "session-vault",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      sessions: (sessions || []).map(function (s) { return s; }),
    };
    if (opts.live) doc.live = opts.live;
    return JSON.stringify(doc, null, 2);
  }

  /* Import our own format. Returns { sessions, errors }: every valid
   * session plus one error string per problem found. Nothing throws. */
  function importJson(text) {
    var sessions = [];
    var errors = [];
    var doc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return { sessions: sessions, errors: ["not valid JSON: " + e.message] };
    }
    if (!isPlainObject(doc)) return { sessions: sessions, errors: ["top level is not an object"] };
    if (doc.format && doc.format !== "session-vault") {
      errors.push("not a Session Vault file (format is " + JSON.stringify(doc.format) + ")");
    }
    if (doc.schemaVersion != null && doc.schemaVersion !== SCHEMA_VERSION) {
      errors.push("unsupported schemaVersion " + doc.schemaVersion);
    }
    var list = Array.isArray(doc.sessions) ? doc.sessions : [];
    if (!list.length) errors.push("no sessions found in file");
    list.forEach(function (raw, i) {
      var check = validateSession(raw);
      if (!check.ok) {
        errors.push("session " + (i + 1) + ": " + check.errors.join("; "));
        return;
      }
      sessions.push(normaliseImported(raw));
    });
    return { sessions: sessions, errors: errors };
  }

  /* OneTab's text export: one tab per line, blank lines separate
   * groups, and a line may be "title | url" or a plain URL. A
   * non-URL line that starts a block is treated as that group's
   * title. Invalid lines are reported, not fatal. */
  function importOneTabText(text) {
    var sessions = [];
    var errors = [];
    var lines = String(text == null ? "" : text).split(/\r?\n/);
    var groups = [];
    var current = null;
    function flush() {
      if (current && current.tabs.length) groups.push(current);
      current = null;
    }
    lines.forEach(function (rawLine, idx) {
      var line = rawLine.trim();
      if (!line) { flush(); return; }
      var url = line;
      var title = "";
      var pipe = line.indexOf(" | ");
      if (pipe !== -1) {
        var left = line.slice(0, pipe).trim();
        var right = line.slice(pipe + 3).trim();
        // OneTab writes "url | title"; accept "title | url" too.
        if (/^https?:\/\//i.test(left) && !/^https?:\/\//i.test(right)) {
          url = left; title = right;
        } else if (/^https?:\/\//i.test(right)) {
          title = left; url = right;
        }
      }
      if (!/^https?:\/\//i.test(url)) {
        if (!current) {
          current = { title: line, tabs: [] };
        } else {
          errors.push("line " + (idx + 1) + ": not a URL, skipped: " + line);
        }
        return;
      }
      if (!current) current = { title: "", tabs: [] };
      current.tabs.push({ url: url, title: title });
    });
    flush();
    if (!groups.length) {
      return { sessions: sessions, errors: errors.concat(["no tabs found in file"]) };
    }
    var now = Date.now();
    var session = {
      id: newId(),
      name: "Imported from OneTab — " + new Date(now).toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric",
      }),
      createdAt: now,
      updatedAt: now,
      source: "manual",
      windows: [{
        name: null, state: "normal", focused: false, incognito: false,
        tabs: [],
      }],
      groups: [],
    };
    groups.forEach(function (g, gi) {
      var ref = null;
      if (g.title) {
        ref = groupRefFor(session.groups.length);
        session.groups.push({ ref: ref, title: g.title, color: "grey", collapsed: false });
      }
      g.tabs.forEach(function (t) {
        session.windows[0].tabs.push({
          url: t.url, title: t.title, pinned: false, active: false,
          index: session.windows[0].tabs.length, groupRef: ref, discarded: false,
        });
      });
    });
    if (!session.windows[0].tabs.length) {
      return { sessions: sessions, errors: errors.concat(["no tabs found in file"]) };
    }
    sessions.push(session);
    return { sessions: sessions, errors: errors };
  }

  /* Tab Session Manager's JSON export. Accepts both the bare-array
   * form and { sessions: [...] }; each session may carry a flat `tabs`
   * list or a `windows` list. Group info, where present, survives. */
  function importTabSessionManagerJson(text) {
    var sessions = [];
    var errors = [];
    var doc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return { sessions: sessions, errors: ["not valid JSON: " + e.message] };
    }
    var list = Array.isArray(doc) ? doc : (isPlainObject(doc) && Array.isArray(doc.sessions) ? doc.sessions : null);
    if (!list) return { sessions: sessions, errors: ["not a Tab Session Manager export (no sessions array)"] };
    if (!list.length) return { sessions: sessions, errors: ["no sessions found in file"] };
    list.forEach(function (raw, i) {
      if (!isPlainObject(raw)) {
        errors.push("session " + (i + 1) + ": not an object, skipped");
        return;
      }
      var now = Date.now();
      var session = {
        id: newId(),
        name: typeof raw.name === "string" && raw.name ? raw.name : "Imported session " + (i + 1),
        createdAt: typeof raw.date === "number" ? raw.date : now,
        updatedAt: now,
        source: "manual",
        windows: [],
        groups: [],
      };
      var rawWindows = Array.isArray(raw.windows) && raw.windows.length
        ? raw.windows
        : [{ tabs: Array.isArray(raw.tabs) ? raw.tabs : [] }];
      rawWindows.forEach(function (w) {
        var win = {
          name: null, state: "normal", focused: false, incognito: false, tabs: [],
        };
        (w.tabs || []).forEach(function (t) {
          if (!isPlainObject(t) || typeof t.url !== "string" || !t.url) return;
          win.tabs.push({
            url: t.url,
            title: typeof t.title === "string" ? t.title : "",
            pinned: !!t.pinned,
            active: !!t.active,
            index: win.tabs.length,
            groupRef: null,
            discarded: false,
          });
        });
        session.windows.push(win);
      });
      var tabsTotal = countTabs(session);
      if (!tabsTotal) {
        errors.push("session " + (i + 1) + " (" + session.name + "): no tabs, skipped");
        return;
      }
      sessions.push(session);
    });
    return { sessions: sessions, errors: errors };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    GROUP_COLORS: GROUP_COLORS,
    newId: newId,
    normaliseUrl: normaliseUrl,
    cannotOpenReason: cannotOpenReason,
    capture: capture,
    defaultSessionName: defaultSessionName,
    countTabs: countTabs,
    countWindows: countWindows,
    dedupeTabs: dedupeTabs,
    planRestore: planRestore,
    diffSnapshots: diffSnapshots,
    canonicalJson: canonicalJson,
    checksum: checksum,
    makeEnvelope: makeEnvelope,
    verifyEnvelope: verifyEnvelope,
    rotateSlots: rotateSlots,
    healSlots: healSlots,
    validateSession: validateSession,
    normaliseImported: normaliseImported,
    exportJson: exportJson,
    importJson: importJson,
    importOneTabText: importOneTabText,
    importTabSessionManagerJson: importTabSessionManagerJson,
  };
});
