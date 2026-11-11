# manga-reader

Tauri v2 + React 19 + TypeScript manga reader. Windows desktop app.

Details live in path-scoped rules that load when matching files are read:
- [.claude/rules/backend.md](.claude/rules/backend.md) — `src-tauri/**`: commands, `manga://` handler, gates, archive pool, thumb cache, capabilities, CSP
- [.claude/rules/frontend.md](.claude/rules/frontend.md) — `src/**`: state, zip switch flow, view modes, shortcuts, sidebar, search

## Git Commit 規則

- 不加 `Co-Authored-By` tag
- message 精簡在一行，不加多行描述

## Dev

```
pnpm tauri dev
```

TypeScript check: `pnpm exec tsc --noEmit`
Rust check: `cd src-tauri && cargo check`
Rust tests: `cd src-tauri && cargo test --lib`

## Stack

| Layer    | Tech |
|----------|------|
| Frontend | React 19, TypeScript, Vite 7, react-window 2 |
| Backend  | Rust (Tauri v2), zip, walkdir, image, tokio (sync) |
| Pkg mgr  | pnpm |

## File layout

```
src/
  main.tsx              — React root (StrictMode)
  App.tsx               — root component, UI state, navigation, drag handlers
  App.css               — dark theme (CSS variables, no framework)
  types.ts              — ZipFileEntry, FolderEntry, ViewMode
  components/
    Sidebar.tsx         — search box, folder tree, zip list, context menu (react-window virtual list)
    Viewer.tsx          — image display (single/double/scroll modes)
    Gallery.tsx         — cover thumbnail grid (gallery mode)
  hooks/
    useKeyboardShortcuts.ts — generic KeyBinding[] hook
    useZipLoader.ts     — open zip, page name list, orientation/failure tracking, srcFor()
  utils/
    store.ts            — saveSetting / loadSetting wrappers for tauri-plugin-store
    pageUrl.ts          — builds `manga://` URLs: pageUrl() for pages, thumbUrl() for gallery covers
    spread.ts           — spreadStride(), lastSpreadStart()
    search.ts           — sidebar search: normalize(), parseQuery(), matchScore()
src-tauri/
  src/
    lib.rs              — all Tauri commands + the `manga://` protocol handler
    main.rs             — entry point
  Cargo.toml
  tauri.conf.json       — includes CSP
  capabilities/
    default.json        — permissions
```

## Cross-layer invariants

These span `src/` and `src-tauri/`, so they live here rather than in one side's rules.

- **Pages and covers are `<img src>` on `manga://`, not IPC.** URLs are built in `utils/pageUrl.ts`
  and parsed in `lib.rs` (`convertFileSrc("", "manga")` = `http://manga.localhost/` on Windows):
  - page: `?zip=<enc>&name=<enc>&v=<mtime>`
  - cover: `?zip=<enc>&thumb=1&v=<mtime>`
- **URLs are immutable.** Responses are `Cache-Control: immutable`; `v` is the zip mtime, so editing
  a zip must mint new URLs. Frontend code relies on this (page-0 pre-decode isn't a double fetch;
  reopening the on-screen zip doesn't re-fire `onLoad`).
- **Page gate = `OPENED_ZIPS` (LRU of 4), never `CURRENT_ZIP`.** The frontend keeps the previous
  zip on screen until the new listing + page-0 decode land, so gating on the single current zip
  403s the pages actually being read. **Cover gate = `SCAN_ROOTS`**, because the gallery requests
  a cover for every zip in the tree.
- **Never `display: none` a page `<img>`** — hidden images aren't decoded, which defeats the
  paged-mode preload.
- **`spreadStride()` is the one double-mode pairing rule** — App and Viewer must agree on it.
- **Sidebar state (`expandedFolders`, `sidebarQuery`) lives in App**, because gallery mode unmounts
  the sidebar.
