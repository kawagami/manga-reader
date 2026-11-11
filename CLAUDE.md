# manga-reader

Tauri v2 + React 19 + TypeScript manga reader. Windows desktop app.

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
| Frontend | React 19, TypeScript, Vite 7 |
| Backend  | Rust (Tauri v2) |
| Pkg mgr  | pnpm |

### Rust crates (src-tauri/Cargo.toml)
- `zip = "2"` — read zip/cbz archives
- `walkdir = "2"` — recursive directory scan
- `image = "0.25"` — decode images + resize for thumbnails (default features: avif is encode-only,
  so avif covers always fail and fall back to the placeholder; pages still render in the webview)
- `tokio = { version = "1", features = ["sync"] }` — `Semaphore` to cap concurrent thumbnail/page jobs
- `percent-encoding = "2"` — decode query params in the `manga://` page protocol
- `tauri-plugin-dialog = "2"` — native folder picker
- `tauri-plugin-store = "2"` — persist settings to JSON
- `tauri-plugin-window-state = "2"` — save/restore window size+position
- `tauri-plugin-single-instance = "2"` — second launch exits and focuses the existing window (registered
  first in `run()`; otherwise two instances race on settings.json, window-state and the thumb cache).
  Rust-only, no capability needed
- `tauri-plugin-opener = "2"` — reveal file in Explorer
- `serde = "1"` (derive) — command return types; `serde_json = "1"` is a Tauri-template leftover,
  not referenced anywhere in `lib.rs`

### npm packages
- `@tauri-apps/api` — invoke, convertFileSrc (`manga://` origin), getCurrentWindow
- `@tauri-apps/plugin-dialog` — open()
- `@tauri-apps/plugin-store` — Store.load()
- `@tauri-apps/plugin-window-state` — restoreStateCurrent
- `@tauri-apps/plugin-opener` — revealItemInDir
- `react-window = "2"` — virtual `Grid` for gallery mode, virtual `List` for the sidebar

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
    useKeyboardShortcuts.ts — generic KeyBinding[] hook; modifiers matched exactly (unlisted ones must be up); handler returning false declines event (no preventDefault → native scroll works in scroll mode); ignores unmodified keys aimed at input/textarea/contentEditable (Ctrl/Alt/Meta combos still fire) and IME composition
    useZipLoader.ts     — open zip, page name list, orientation/failure tracking, srcFor()
  utils/
    store.ts            — saveSetting / loadSetting wrappers for tauri-plugin-store (retries if Store.load failed)
    pageUrl.ts          — builds `manga://` URLs: pageUrl() for pages, thumbUrl() for gallery covers
    spread.ts           — spreadStride(): shared double-mode pairing rule (App + Viewer must agree); lastSpreadStart(): End / forward-jump target
    search.ts           — sidebar search: normalize() (NFKC + lowercase), parseQuery(), matchScore()
src-tauri/
  src/
    lib.rs              — all Tauri commands
    main.rs             — entry point
  Cargo.toml
  tauri.conf.json
  capabilities/
    default.json        — permissions
```

## Rust commands (src-tauri/src/lib.rs)

### `scan_directory(path: String) -> Result<Vec<FolderEntry>, String>`
async + `spawn_blocking`. Errors if path is not a directory.
walkdir from root, group .zip/.cbz files by immediate parent folder.
Natural-sorted (numeric-aware, deterministic tiebreaks). Returns tree for sidebar.
Each `ZipFileEntry` carries `mtime` (from walkdir's already-cached metadata, so no extra
stat) — the cache-busting version in the cover URL.
On success also pushes `path` onto `SCAN_ROOTS` (the thumb gate) and clears `FAILED_THUMBS`.

### `list_zip_images(zip_path: String) -> Result<ZipListing, String>`
`ZipListing { names: Vec<String>, mtime: u64 }`. Reads the zip central directory only
(no entry opens). Names are natural-sorted and filtered by `is_page_entry` =
image extension **and not** `is_junk_entry` (directory entries, `__MACOSX/` shadow
trees, `._*` AppleDouble files, `Thumbs.db`/`.DS_Store`) — AppleDouble entries keep
the original extension, so without this every page appears twice and `._001.jpg`
sorts first and becomes an undecodable cover.
`mtime` is the cache-busting version the frontend puts in page URLs.
Sets `CURRENT_ZIP`, pushes the path onto `OPENED_ZIPS` (the page gate), and drops the previous
zip's pooled handles immediately.

## `manga://` protocol (not a command)

Pages **and gallery covers** go straight to `<img src>` via
`register_asynchronous_uri_scheme_protocol("manga", …)` instead of being shipped over IPC as
ArrayBuffers. The webview then owns fetching, decode scheduling and memory eviction — that is
what makes `loading="lazy"` viable in both scroll mode and the gallery, and removes the need for
a hand-rolled load window, blob URLs and revoke bookkeeping.

URLs (built by `utils/pageUrl.ts`; `convertFileSrc("", "manga")` is `http://manga.localhost/`
on Windows):
- page: `?zip=<enc>&name=<enc>&v=<mtime>`
- cover: `?zip=<enc>&thumb=1&v=<mtime>`

The handler branches on `thumb` **before** taking a permit, because the two paths need separate
caps: a gallery scroll must not eat the page budget, and a thumb costs a full-size decode.

### `serve_page`
Two gates before any I/O — 403 for non-`is_page_entry` names, and 403 unless `zip` is in
`OPENED_ZIPS` (without it the scheme is a read primitive for **any** zip on disk, since the path
comes straight off the URL). Then takes an archive from the pool, reads the entry, returns it
with the right `Content-Type` and `Cache-Control: max-age=31536000, immutable` — safe because
`v` is the zip mtime, so editing a zip mints new URLs rather than leaving stale ones cached.
Concurrency capped at 6 (`PAGE_SEM`); the webview otherwise fires a request per `<img>`.

### `serve_thumb`
JPEG thumbnail (≤150×200) of the zip's first page. Gate is `is_scanned_zip`, **not**
`OPENED_ZIPS` — the gallery requests a cover for every zip in the tree, not just opened ones.
`SCAN_ROOTS` is an LRU of the last 4 roots passed to `scan_directory`; the check is
`Path::starts_with` (whole components, so a `C:\books` root does not admit `C:\booksXXX\evil.zip`)
plus a .zip/.cbz extension check, so the handler can't become a reader for arbitrary files.

Async rather than one `spawn_blocking` because the disk-cache lookup sits deliberately *outside*
`THUMB_SEM`: a gallery scroll is nearly all hits, and making them queue behind four cold decodes
stalls the grid. Cache is `AppCache/thumbs/{hash}.jpg`, key = FNV-1a of path+mtime (stable across
Rust versions, unlike `DefaultHasher`); hits rewrite the file if >7 days old so hot thumbs survive
the sweep. Miss → acquire `THUMB_SEM` (4) → `generate_thumb`: open the zip **directly, not via the
pool** (gallery zips aren't the zip being read; pooling them would evict the current one's
handles) → first image → `decode_limited` + `thumbnail(150,200)` → JPEG q80 → cache → return.
`decode_limited` applies `image::Limits` (256 MB alloc, 20000px per side) — the full-size decode
that precedes downscaling is ~96 MB for a 4000×6000 source, ×4 in parallel.

A failure leaves nothing in the disk cache, so `FAILED_THUMBS` (in-memory set, cleared on
rescan) negative-caches it — otherwise every scroll past a corrupt zip's card reopens it and
reparses its central directory. This is the Rust-side replacement for the old `useCoverLoader`
`failedRef`.

`THUMBS_DIR` is resolved once in `.setup()`: the protocol handler has no `AppHandle`, and
re-resolving `app_cache_dir()` per request would stat the cache dir on every gallery cell.
Startup sweep (`clean_thumb_cache`, spawned in `.setup()`): deletes thumbs older than 30 days.

`read_entry` caps decompressed output at `MAX_ENTRY_BYTES` (128 MB) via `Read::take` — `alloc_hint`
only bounds the *initial* Vec, so an entry claiming 1 KB can still inflate to gigabytes and OOM.
Reads one byte past the cap so oversized entries error instead of truncating into a corrupt image.

### `OPENED_ZIPS` (the page gate) vs `CURRENT_ZIP` (pool ownership)
Two different lifetimes, hence two statics. `CURRENT_ZIP` must be single-valued — the pool caches
handles for one zip only. The gate must **not** be: `list_zip_images` moves `CURRENT_ZIP` at the
*start* of a switch, but the frontend keeps the previous zip on screen until the listing and
page-0 decode land. Gating on `CURRENT_ZIP` 403s every page of the zip actually being read during
that window, and gallery → double mode remounts the entire paged view inside it (`selectZip` is
async, `changeViewMode("double")` is not), so every preloaded `<img>` in that view (up to ~38 in double mode) fails at once.
`OPENED_ZIPS` is an LRU of the last 4 zips passed to `list_zip_images`; arbitrary paths are still
rejected, which is the property that matters.

### Archive pool + Windows file lock
Pool: global `Mutex<Vec<(path, ZipArchive)>>`, max 4 handles, current zip only — avoids
reparsing the central directory per page while keeping 4-way read parallelism. `CURRENT_ZIP`
(set by `list_zip_images`) rejects stale returns from a previously opened zip.

Idle pooled handles keep the zip file locked on Windows (blocks delete/rename in Explorer).
With the webview driving requests there is no frontend "queue drained" moment to hook, so
`spawn_pool_reaper` wakes every 1.5 s and clears the pool once `LAST_READ` is ≥1.5 s old — so
handles are released 1.5–3 s after the last read. This replaces
the old `release_zip_handles` command.

All statics use `lock_ok()` (`unwrap_or_else(|e| e.into_inner())`) — a panicking reader
would otherwise poison the mutex and turn every later page request into a panic.

## Frontend architecture

### State (App.tsx)
- `folderTree` — sidebar tree from `scan_directory`
- `selectedZip` — currently open zip path
- `currentPage` — page index (0-based)
- `viewMode` — `"single" | "double" | "scroll" | "gallery"`
- `expandedFolders` — sidebar's expanded folder paths. Lives here, **not** in Sidebar: gallery
  mode unmounts the sidebar, so state held inside it was wiped every time the user looked at
  the covers. Cleared on root change (old folder paths are meaningless then)
- `sidebarQuery` / `searchRef` — sidebar search text and its `<input>` (for `Ctrl+F`). App-owned
  for the same gallery-unmount reason; **not** cleared on root change
- `effectiveStride` — `spreadStride(images, imgLandscape, currentPage, viewMode === "double")`
- `flat` / `zipIndex` — `useMemo`'d flattened zip paths + path→index map for zip navigation
  (this used to be a `flatMap` + `indexOf` on every render)

### State (useZipLoader hook)
No load queue, no blob URLs, no windowing — pages are `<img src>` pointing at `manga://`.
The hook only tracks which pages exist and what has been learned about them:
- `zip` — single `{ path, mtime, names }` state object, so the swap to a new zip is atomic
- `images` — `zip?.names ?? NO_IMAGES` (stable empty array so effects don't refire)
- `srcFor(name)` — `pageUrl(zip.path, name, zip.mtime)`
- `imgLandscape` — `Map<name, boolean>`, set from `<img onLoad>`. Doubles as the "loaded"
  flag in paged mode (drives the "Loading…" placeholder)
- `failedPages` — `Set<name>` from `<img onError>`; Viewer shows "Failed to load"
- `zipError` — zip open failure (also "No images found in this zip" for empty zips — the
  default "Select a zip file" message would be wrong there), shown in Viewer
- `activeZipRef` — guards against a slow listing for zip A landing after the user opened B

### Zip switch flow
`selectZip(path)` in App.tsx sets `selectedZip`, then delegates to `useZipLoader.selectZip(path, onSwap)`:
1. `activeZipRef.current = path`
2. `invoke("list_zip_images", { zipPath })` → `{ names, mtime }`
3. `new Image()` + `decode()` on page 0's URL — the old zip stays on screen instead of
   flashing empty. Not a double fetch: page URLs are immutable, so the real `<img>` hits
   the webview cache
4. Atomic swap: one `setZip(...)` + cleared landscape/failed maps; `onSwap()` resets `currentPage`.
   **Exception:** reopening the zip already on screen (same path + mtime, compared via `zipRef`) only
   calls `onSwap()` — the page URLs are identical, so mounted `<img>`s never re-fire `onLoad`, and
   clearing `imgLandscape` (the paged-mode "loaded" flag) would leave every page stuck on "Loading…"
5. Every step re-checks `activeZipRef.current === path` (stale guard)
6. On error: `setZip(null)` + `zipError` → Viewer shows the error

### Gallery covers
No hook and no state at all: `<img src={thumbUrl(zip.path, zip.mtime)} loading="lazy">`.
The webview requests covers as cells scroll in and evicts them itself.

This replaced `useCoverLoader` (~96 lines), which shipped covers over IPC as ArrayBuffers and
hand-rolled everything the browser already does: a bounded blob-URL LRU with revoke bookkeeping
(blob URLs leak unless something frees them), a 50 ms batch timer (committing per cover copied
the whole Map and re-rendered every visible card — O(n²) over a library scroll), a generation
counter to invalidate in-flight loads, and an `onCellsRendered` fan-out that re-requested every
visible cover on each render pass.

Two things the rewrite still has to get right:
- the cover `<img>` is keyed by `src`, because react-window keys cells by position, not by zip —
  a resize that changes the column count (or a rescan) puts a different zip into the same cell
  node, and without the key the imperative `cover-failed` class would stick to it
- `.gallery-cover` carries the placeholder colour as its own `background`, since there is no
  longer a separate placeholder element to swap in before the image lands

### Error toast
`showNotice(msg)` in App.tsx — transient 4s toast (`.toast`), used for scan failures
(drag-drop of invalid folder, Open Directory). Zip open failures render in Viewer instead.

### Persistence (settings.json via tauri-plugin-store)
- `lastDir` — last opened root directory (auto-scanned on startup)
- `viewMode` — last selected view mode

Window size/position: `tauri-plugin-window-state` (auto-saves on close, `restoreStateCurrent(StateFlags.ALL)` on startup)

## View modes

| Mode   | Behaviour |
|--------|-----------|
| single | One page centered. ←/↑ previous, →/↓/Space next. |
| double | Two pages side-by-side, **right-to-left** (manga order): page N on right, N+1 on left. stride = 2. A spread collapses to a single page when **either** half is landscape (`spreadStride` — checking only the lead page squeezed a landscape N+1 into half a spread). Paged mode pre-renders 6 spreads forward (orientation-aware stride) at `opacity: 0`, so turning a page is just an opacity flip on already-decoded images. Backwards it pre-renders *every* page within reach of 6 spreads (`stride × 6` → 12 pages in double, 6 in single), because a landscape page shifts parity and stride-2 skipping backwards would miss reachable pages — so a double-mode view holds up to ~19 spreads / ~38 `<img>`. **Never `display: none` a page `<img>`** — hidden images are not decoded, which silently defeats the preload and makes every page turn flicker; the "Loading…" placeholder therefore renders *beside* the img (0×0 until loaded), not in place of it. Backward spreads come first in DOM order, so the active spread carries `fetchPriority="high"` to avoid queueing behind preloads after a jump. |
| scroll | All pages stacked vertically, native scroll + `loading="lazy"` — the webview decides what to fetch and evict, so a 500-page zip no longer pins 500 blobs. `.scroll-img` reserves a `2/3` aspect box so lazily-arriving pages don't shove everything below them; `onLoad` clears it to `auto` imperatively (a state update would re-render all N page nodes). Current page comes from an `IntersectionObserver` whose root is collapsed to a line at the viewport centre (`rootMargin: -50% 0 -50%`) — O(1), replacing a scroll handler that walked every page and read `offsetTop`. Position carries scroll → paged only: entering scroll mode starts at the top and the observer immediately reports page 0, overwriting `currentPage` (known gap). |
| gallery | Cover thumbnail grid for all zips (react-window virtual grid). Click → open in double mode. Covers are plain lazy `<img>`s on the `manga://` scheme (`?thumb=1`). Zip-nav keys (Numpad0/8/5, Alt+↑↓) also open in double mode. |

## Keyboard shortcuts

Page keys act only in single/double mode; in scroll mode the handler returns `false`, so the
browser's native scrolling handles them. Zip keys work in every mode.

| Key | Action |
|-----|--------|
| `←` / `↑` | Previous page |
| `→` / `↓` | Next page |
| `Space` | Next page |
| `PageUp` | Back 5 spreads (`stride × 5`: 5 pages single, 10 double) |
| `PageDown` | Forward 5 spreads (`stride × 5`: 5 pages single, 10 double) |
| `Numpad7` | Back 5 spreads (`stride × 5`: 5 pages single, 10 double) |
| `Numpad9` | Forward 5 spreads (`stride × 5`: 5 pages single, 10 double) |
| `Home` / `Numpad1` | First page |
| `End` / `Numpad3` | Last page — `lastSpreadStart()`, i.e. where paging forward from page 0 stops, not `images.length - 1` |
| `Numpad4` | Previous page |
| `Numpad6` | Next page |
| `Alt+↑` | Previous zip (cross-folder, sidebar order) |
| `Alt+↓` | Next zip (cross-folder, sidebar order) |
| `Numpad8` | Previous zip (cross-folder, sidebar order) |
| `Numpad5` | Next zip (cross-folder, sidebar order) |
| `Numpad0` | Random zip from loaded tree (uniform over zips, with replacement) |
| `Ctrl+F` | Focus sidebar search (no-op in gallery) |

Zip nav / random use the **whole** tree, not the search results. Inside the search box: `Enter`
opens the first result and blurs, `Esc` clears and blurs — both hand the keys back to the reader.

The 5-spread jumps multiply the **current** spread's stride (`effectiveStride × 5`), so in double
mode a jump from a collapsed (landscape or last-page) spread moves 5 pages, not 10.
Forward jumps clamp to `lastSpreadStart()` (same target as `End`): clamping to `images.length - 1`
showed the final page alone in double mode and shifted every spread's pairing by one on the way back.

## Drag and drop
Drop a **folder** → `scan_directory`, load as new root.
Drop a **.zip/.cbz** → open directly as if selected in sidebar. Known gap: the drop handler calls
`selectZip`, not `openZip`, so in gallery mode the zip loads with no viewer mounted (keyboard zip
nav switches to double mode; drop doesn't).
Visual: orange dashed overlay during drag.

## Sidebar behaviour
`expanded` is a prop from App, not local state — see `expandedFolders` above.
- Click folder header → expand/collapse
- Click zip → open
- Right-click zip → context menu → "Open file location" (`revealItemInDir`)
- When `selectedZip` changes (keyboard nav / random / drag-drop): auto-expand parent folder, then
  `list.scrollToRow({ index, align: "auto" })`

Virtualised with react-window's `List`: the tree is flattened to a `Row[]`
(`{kind:"folder"} | {kind:"zip"}`) rebuilt whenever `folders` or `expanded` changes. An expanded
folder used to put one `<div>` per zip in the DOM, so a few thousand zips in one folder froze it.
Consequences of virtualising:
- Row heights must be known up front, so the `rowHeight` callback returns `ROW_H_FOLDER` (31) /
  `ROW_H_ZIP` (27); `.folder-header` / `.zip-item` are `height: 100%` of the row box react-window
  sizes from those numbers (global `box-sizing: border-box`, so the border is inside). **The
  constants alone decide row height** — CSS padding/borders can't change it, they can only
  misalign content inside the fixed box. The one coupling: `.zip-item` centres its text with
  `line-height: 26px` = `ROW_H_ZIP` − 1px `border-bottom`, so changing either means changing the
  other. `.folder-header` is a flex row with `align-items: center` and needs no adjustment.
- Scroll-to-selection can't use `scrollIntoView` — the row often isn't mounted. Goes through
  `useListRef` → `scrollToRow` instead, guarded by `scrolledZipRef` so manual folder toggles
  don't yank the view back to the selection.
- `.sidebar` is `overflow: hidden`; the `List` owns the scrollbar.

### Search
Search box sits above the list (`.sidebar-search`, outside the `ROW_H_*` bookkeeping); the list
lives in `.sidebar-list` (`flex: 1; min-height: 0`). Matching (`utils/search.ts`): query split on
whitespace, **every** term must be a substring (AND) of `"folder\nzip"` — substring, not fzf-style
subsequence, because CJK names + `[tags]` make subsequence match nearly everything. Both sides are
NFKC-normalized (full/half-width fold); `searchText` is precomputed per scan, so a keystroke over
~4k zips is a few ms. Score per term: 0 text start, 1 word start, 2 mid-word.
"Word start" = after a `BOUNDARY` char (whitespace incl. the `\n` separator, brackets, `| _ - . ~ ・`),
so only the **folder** name start scores 0 — a zip name start scores 1. Only a term's first
occurrence is scored (`indexOf`).
No 繁簡 folding (汉化 ≠ 漢化).

While searching, rows are only matching folders (ranked by best zip, stable) with their matching
zips, all expanded; count shows `matched/total`. Collapsing a result folder goes to
`searchCollapsed` (tagged with its query), **not** `expanded`, so clearing the search restores
the tree untouched. New query → `scrollToRow(0)`; cleared → `scrolledZipRef` reset so the
selection effect scrolls back to the open zip.

## Capabilities (src-tauri/capabilities/default.json)
```json
["core:default", "opener:default", "dialog:allow-open", "store:default", "window-state:default"]
```

## CSP (tauri.conf.json → app.security)
`csp` (prod) and `devCsp` are both set — `null` would leave the `manga://` read gate as the only
thing standing between injected content and the filesystem. Allowances that matter:
`img-src` needs `manga:`/`http://manga.localhost` (pages **and** covers — `blob:` was dropped
when covers stopped being object URLs, and nothing else uses it; `asset:`/`http://asset.localhost`
and `data:` are Tauri's defaults, kept but unused);
`style-src 'unsafe-inline'` for Vite's injected `<style>` (only needed under `pnpm tauri dev` —
the prod build extracts CSS to a file — but kept in `csp` too, harmlessly); `connect-src` needs `ipc:`/
`http://ipc.localhost` for every `invoke`. `devCsp` adds `'unsafe-inline' 'unsafe-eval'` for the
react-refresh preamble and `ws://localhost:1420` + `http://localhost:1420` for the dev server
and HMR. Tauri's own init script is injected at
the WebView level, not as a `<script>` tag, so it isn't subject to this.
