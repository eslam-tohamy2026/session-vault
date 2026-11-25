# Changelog

All notable changes to Session Vault are documented here.

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
