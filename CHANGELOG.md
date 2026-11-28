# Changelog

All notable changes to Session Vault are documented here.

## [2.0.0] - 2026-11-28

A major release: restore is now granular, the library is organisable, and four real defects are fixed. Nothing about storage changed — v1 sessions, trash and backups load exactly as before; no migration is needed.

### Added

- Restore a whole session, one window, just the tabs you tick, or a single tab — every variant goes through the same confirmation dialog and the same honest preview (how many tabs will open, how many are already open, which ones cannot be opened and why).
- Tags on sessions (up to 10, set in the Rename dialog), with one-click tag filtering in the sidebar.
- Sorting: newest, oldest, name A–Z, most tabs first.
- Trash that works: restore a deleted session from the Trash tab, delete one forever, or empty the whole trash in one click (with confirmation).
- Export a session as a plain-text list of links, alongside the JSON export.
- Search now covers the whole session — names, tags, tab titles and URLs — instead of only the first ten tabs.
- The public preview on GitHub Pages now shows three labelled sample sessions and opens the first one, so visitors see the library instead of an empty page.
- Real screenshots of the manager and popup in `docs/screenshots/`, rendered with headless Chromium (`docs/screenshots/take-screenshots.py` reproduces them).

### Fixed

- Self-healing no longer parks the damaged mirror slot as the fallback: after a heal, the previous slot keeps the copy that just proved itself good. Before, a second failure could have healed from a copy already known to be bad.
- The daily file backup no longer misses manual saves: it is written whenever anything changed (any session or the live snapshot), and a library with saved sessions but no live snapshot yet still gets its first file.
- Trash entries showed the wrong date (the original save date, labelled "Deleted"). They now show the actual deletion time.
- Pressing Enter in the Rename dialog cancelled instead of saving: Cancel was the first submit button in the dialog. Cancel buttons are now `type="button"` and the confirm buttons are the submit buttons in all three dialogs.
- Hidden banners and bars were visible anyway: `.banner` and `.restore-bar` set `display: flex`, which overrides the browser's built-in `[hidden]` rule — so the recovery banner, an empty integrity alert and the trash bar all showed in the preview even when hidden. The stylesheet now forces `[hidden]` off. (Found by the v2 screenshot review; the bug existed in v1.)
- Importing the same file twice no longer duplicates sessions, and a foreign file can no longer silently overwrite a different session that shares an id — it is saved under a fresh id instead.
- The backup-folder flow no longer writes the daily file twice when a folder is picked.
- Corrected the Tab Session Manager import note: its export does not carry group titles in a mappable form, so imported tabs arrive ungrouped rather than wrongly grouped.

### Changed

- Version 2.0.0: the restore granularity, tags, sorting and trash work are a significant new surface, and the healed-mirror and backup fixes change behaviour users can notice — a major bump, not a patch.
- README rewritten with real screenshots, an honest comparison table against Session Buddy 4.1.2, Tab Session Manager 7.4 and Workona (figures read November 2026), and a plain statement of what Session Vault deliberately does not do.

## [1.0.1] - 2026-11-25

- Fixed: the two primary buttons inside the amber banners ("Restore the snapshot", "Pick a backup folder") rendered with white text on a white background, so their labels were invisible until hovered. Banner buttons now keep their blue background.
- Fixed: the "Recently closed" tab label wrapped onto two lines.
- The manager page is also served as a public preview on GitHub Pages, where the extension APIs do not exist. It now detects that and shows a clear preview notice, resolves the status badge to "Preview" instead of hanging on "Checking…", and disables the actions that need the extension. Local UI (search, view tabs, dialogs) keeps working. A message to the extension that is never answered now fails after 30 seconds instead of hanging silently.

## [1.0.0] - 2026-11-25

- First release.
- Manual save (current window or all windows) from the toolbar popup or the manager page.
- Event-driven auto-save on every tab, window and group change (2 s debounce) plus a 5-minute alarm backstop.
- Crash recovery: on browser start, a banner offers to restore the last auto-saved snapshot when tabs are missing; Chrome's recently-closed list is a second recovery source.
- Restore a whole session, one window, or selected tabs, into a new window or the current window; tabs open unloaded by default, the originally-active tab loads; pinned tabs, tab groups (title, colour, collapsed) restored; duplicates skipped by default with a count.
- Three-copy integrity: IndexedDB primary, a rotating checksummed mirror pair in `chrome.storage.local`, and dated JSON files in a folder the user chooses (File System Access). Startup verification heals a damaged copy from the next good one and says so.
- Search across session names, tab titles and URLs.
- Export / import JSON (versioned format); imports OneTab text lists and Tab Session Manager JSON.
- Delete / rename sessions; trash keeps deleted sessions 30 days.
- Backup folder picker with a persistent nudge until one is chosen; dated JSON written on every manual save and every 15 minutes by alarm.
