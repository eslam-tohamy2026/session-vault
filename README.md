# Session Vault

Save every tab session. Restore it exactly. Lose nothing.

> A browser extension (Chrome / Edge, Manifest V3) that saves whole browsing sessions — every window, every tab, every tab group — and restores them exactly, with an auto-save that runs on every tab change and a crash-recovery banner on the next browser start.

![Session Vault](icons/icon128.png)

## Why another session manager?

OneTab (2M users), Session Buddy (1M) and Tab Session Manager (100K) together serve ~3.1M people — and all three sit at 3.3–3.8 stars, because their users keep losing work: saved sessions vanish after an update, tabs "simply disappear" when saved, restores lose window names and tab groups, and nothing is captured when the browser crashes. Every one of them keeps a single copy of your sessions inside the browser profile.

Session Vault is built around a guarantee, engineered rather than claimed:

- **Three independent copies of every session.** (1) IndexedDB is the primary store. (2) A rotating pair of slots in `chrome.storage.local` mirrors the latest auto-save, each with a SHA-256 checksum — a torn write can only ever damage the slot being written. (3) A dated JSON file in a folder *you* choose, outside the browser profile, written through the File System Access API — it survives a wiped profile, a wiped browser, or an uninstalled extension.
- **Verified on every start.** The mirror is checksum-verified on browser start and on every manager-page open. If a copy is damaged, the extension heals itself from the next good copy and tells you plainly — it never silently opens to an empty list.
- **Auto-save that actually runs.** Every tab, window and group change marks the live snapshot dirty (2 s debounce); a 5-minute alarm backstop re-captures anything a missed event or a killed service worker left behind.
- **Restore that respects the original.** Whole session, one window, or selected tabs; into a new window or the current one; tabs open **unloaded** by default (only the active tab loads), pinned tabs stay pinned, groups come back with their title, colour and collapsed state. Tabs already open are skipped by default, with a count; tabs that cannot be opened (`chrome://` pages, `file://` without the toggle) are listed with the reason — a restore is never reported as complete when it was not.
- **Free forever.** No account, no sync, no server, no paid tier.

## Privacy

Your tabs never leave the device. No server, no account, no tracking, no sync. The only place a session goes outside the browser is a file in a folder *you* chose. The code has no `fetch`, no XHR, no analytics, no third-party script, no host permissions.

**Permissions, each justified:**

| Permission | Why | Install warning |
|---|---|---|
| `tabs` | Read tab URLs/titles; create, move and discard tabs on restore | **"Read your browsing history"** — the one install warning. It is unavoidable and honest: a session manager that cannot read tab URLs cannot save sessions. Every incumbent shows the same warning. |
| `tabGroups` | Read and restore group titles, colours and collapsed state | None |
| `storage` | The local mirror, the session index and settings | None |
| `sessions` | Read Chrome's recently-closed list as a second recovery source | None |
| `alarms` | The 5-minute auto-save backstop and 15-minute file backup | None |
| `unlimitedStorage` | Lifts the 10 MB `storage.local` cap and exempts the extension's IndexedDB from quota eviction | None |

Not requested: `history` (never read), `downloads` (file backup uses the File System Access API instead), `identity` (no sign-in, no cloud), any host permission (never touches page content).

**One honest limitation:** Chrome does not expose window names to extensions, so a saved session cannot restore a window's name — the name field is stored for the future but is empty today. Tab history, scroll position and form contents are likewise not stored (Chrome cannot restore another tab's history). The manager page says this plainly.

## Install (load unpacked)

```bash
git clone https://github.com/eslam-tohamy2026/session-vault.git
cd session-vault
```

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Click the extension icon in your toolbar — the popup saves a session in one click; **Open Session Vault** opens the library.

## Use it

- **Save:** click the toolbar icon → *Save this window* or *Save all windows*; or *Save all windows* in the manager. Saved sessions appear in the library with their window/tab counts.
- **Auto-save:** already running. Change a tab and the live snapshot updates within seconds; the popup shows when it last saved.
- **Recover after a crash:** on the next start, an amber banner offers to restore the last auto-saved snapshot, with its time and tab count. The *Recently closed* tab lists what Chrome itself remembers (up to 25 items).
- **Restore:** select a session → *Restore…* → confirm the target window, whether to skip duplicates, and whether tabs open unloaded.
- **Backup folder:** pick a folder once (manager top bar) and a dated `session-vault-YYYY-MM-DD.json` is written there on every manual save and every 15 minutes. Until you pick one, the manager shows a calm reminder — everything else still works.
- **Search:** `/` focuses the search box; it searches session names, tab titles and URLs.
- **Trash:** deleted sessions are kept 30 days and can be restored from the *Trash* tab.

## Import

The manager's *Import…* button accepts three formats:

- **Session Vault JSON** — our own versioned export (`{ format: "session-vault", schemaVersion: 1, sessions: [...] }`).
- **OneTab text export** — one tab per line (`url | title`), blank lines separate groups; a non-URL line starting a block becomes that group's title.
- **Tab Session Manager JSON** — its sessions array, with flat `tabs` or `windows` lists.

A file that fails validation is reported line by line — the good sessions still import, nothing crashes.

## Development

```bash
npm test
```

Runs the Node test suite: the pure session model (`tests/test_sessionstore.mjs`, 13 tests) and the restore engine against a fake Chrome API (`tests/test_restore.mjs`, 6 tests). Zero dependencies — the tests run with plain Node, no install step.

## File layout

```
manifest.json          Manifest V3, exactly six permissions
background.js          Service worker: auto-save, alarms, integrity, messages
lib/sessionstore.js    Pure session model (UMD — same file runs in Node tests)
lib/idb.js             IndexedDB promise wrapper
lib/backup.js          File System Access backup (pure filename helpers + writes)
lib/restore.js         Restore engine (injected Chrome API — testable in Node)
popup/                 Toolbar popup: two one-click saves
manager/               Session library: list, search, detail, restore, import
icons/                 Locally generated icons (16/32/48/128)
tests/                 Node tests, no chrome.* anywhere
```

## License

MIT — see [LICENSE](LICENSE).
