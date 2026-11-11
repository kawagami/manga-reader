---
paths:
  - "src/**"
---

# Frontend (src)

See the cross-layer invariants in the root CLAUDE.md — URL format, immutability, and the gates are
shared with the backend.

## npm packages
- `@tauri-apps/api` — invoke, convertFileSrc (`manga://` origin), getCurrentWindow
- `@tauri-apps/plugin-dialog` — open()
- `@tauri-apps/plugin-store` — Store.load()
- `@tauri-apps/plugin-window-state` — restoreStateCurrent
- `@tauri-apps/plugin-opener` — revealItemInDir
- `react-window = "2"` — virtual `Grid` for gallery mode, virtual `List` for the sidebar

## State (App.tsx)
- `folderTree` — sidebar tree from `scan_directory`
- `selectedZip` — currently open zip path
- `currentPage` — page index (0-based)
- `viewMode` — `"single" | "double" | "scroll" | "gallery"`
- `expandedFolders` — sidebar's expanded folder paths. Lives here, **not** in Sidebar: gallery
  mode unmounts the sidebar, so state held inside it would be wiped every time the user looks at
  the covers. Cleared on root change (old folder paths are meaningless then)
- `sidebarQuery` / `searchRef` — sidebar search text and its `<input>` (for `Ctrl+F`). App-owned
  for the same gallery-unmount reason; **not** cleared on root change
- `effectiveStride` — `spreadStride(images, imgLandscape, currentPage, viewMode === "double")`
- `lastPage` — `useMemo`'d `lastSpreadStart(...)`: target of `End`/`Numpad3` and the clamp for forward jumps
- `flat` / `zipIndex` — `useMemo`'d flattened zip paths + path→index map for zip navigation

## State (useZipLoader hook)
Pages are `<img src>` pointing at `manga://`; the webview does the loading. The hook only tracks
which pages exist and what has been learned about them:
- `zip` — single `{ path, mtime, names }` state object, so the swap to a new zip is atomic
- `images` — `zip?.names ?? NO_IMAGES` (stable empty array so effects don't refire)
- `srcFor(name)` — `pageUrl(zip.path, name, zip.mtime)`
- `imgLandscape` — `Map<name, boolean>`, set from the **paged-mode** `<img onLoad>` (scroll-mode
  pages don't report orientation). Doubles as the "loaded" flag in paged mode (drives the
  "Loading…" placeholder)
- `failedPages` — `Set<name>` from `<img onError>`; Viewer shows "Failed to load"
- `zipError` — zip open failure (also "No images found in this zip" for empty zips — the
  default "Select a zip file" message would be wrong there), shown in Viewer
- `activeZipRef` — guards against a slow listing for zip A landing after the user opened B

## Zip switch flow
`selectZip(path)` in App.tsx sets `selectedZip`, then delegates to `useZipLoader.selectZip(path, onSwap)`
(destructured as `loadZip` in App):
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
6. On error: `setZip(null)` + cleared landscape/failed maps + `zipError`, then `onSwap()` → Viewer
   shows the error

## Gallery covers
No hook and no state: `<img src={thumbUrl(zip.path, zip.mtime)} loading="lazy">`.
The webview requests covers as cells scroll in and evicts them itself. Two things to keep right:
- the cover `<img>` is keyed by `src`, because react-window keys cells by position, not by zip —
  a resize that changes the column count (or a rescan) puts a different zip into the same cell
  node, and without the key the imperative `cover-failed` class would stick to it
- `.gallery-cover` carries the placeholder colour as its own `background`; there is no separate
  placeholder element

## Error toast
`showNotice(msg)` in App.tsx — transient 4s toast (`.toast`), used for scan failures
(drag-drop of invalid folder, Open Directory). Zip open failures render in Viewer instead.

## Persistence (settings.json via tauri-plugin-store)
- `lastDir` — last opened root directory (auto-scanned on startup)
- `viewMode` — last selected view mode

`utils/store.ts` retries if `Store.load` failed.
Window size/position: `tauri-plugin-window-state` (auto-saves on close, `restoreStateCurrent(StateFlags.ALL)` on startup)

## View modes

| Mode   | Behaviour |
|--------|-----------|
| single | One page centered. ←/↑ previous, →/↓/Space next. |
| double | Two pages side-by-side, **right-to-left** (manga order): page N on right, N+1 on left. stride = 2. A spread collapses to a single page when **either** half is landscape (`spreadStride`). Paged mode pre-renders 6 spreads forward (orientation-aware stride) at `opacity: 0`, so turning a page is just an opacity flip on already-decoded images. Backwards it pre-renders *every* page within reach of 6 spreads (a fixed `(double ? 2 : 1) × 6` → 12 pages in double, 6 in single, regardless of the current stride), because a landscape page shifts parity and stride-2 skipping backwards would miss reachable pages — so a double-mode view holds up to ~19 spreads / ~38 `<img>`. **Never `display: none` a page `<img>`** — hidden images are not decoded, which silently defeats the preload and makes every page turn flicker; the "Loading…" placeholder therefore renders *beside* the img (0×0 until loaded), not in place of it. Backward spreads come first in DOM order, so the active spread carries `fetchPriority="high"` to avoid queueing behind preloads after a jump. |
| scroll | All pages stacked vertically, native scroll + `loading="lazy"` — the webview decides what to fetch and evict. `.scroll-img` reserves a `2/3` aspect box so lazily-arriving pages don't shove everything below them; `onLoad` clears it to `auto` imperatively (a state update would re-render all N page nodes). Current page comes from an `IntersectionObserver` whose root is collapsed to a line at the viewport centre (`rootMargin: -50% 0 -50%`) — O(1), no per-page `offsetTop` reads. Position carries scroll → paged only: entering scroll mode starts at the top and the observer immediately reports page 0, overwriting `currentPage` (known gap). |
| gallery | Cover thumbnail grid for all zips (react-window virtual grid). Click → open in double mode. Covers are plain lazy `<img>`s on the `manga://` scheme (`?thumb=1`). Zip-nav keys (Numpad0/8/5, Alt+↑↓) also open in double mode. |

## Keyboard shortcuts

`useKeyboardShortcuts` takes a generic `KeyBinding[]`: modifiers are matched exactly (unlisted ones
must be up); a handler returning `false` declines the event (no `preventDefault`); unmodified keys
aimed at input/textarea/contentEditable are ignored (Ctrl/Alt/Meta combos still fire), as is IME
composition.

Page keys act only in single/double mode; in scroll and gallery mode the handler returns `false`,
so the browser's native scrolling handles them. Zip keys work in every mode.

| Key | Action |
|-----|--------|
| `←` / `↑` | Previous page |
| `→` / `↓` | Next page |
| `Space` | Next page |
| `PageUp` / `Numpad7` | Back 5 spreads (`stride × 5`: 5 pages single, 10 double) |
| `PageDown` / `Numpad9` | Forward 5 spreads (`stride × 5`: 5 pages single, 10 double) |
| `Home` / `Numpad1` | First page |
| `End` / `Numpad3` | Last page — `lastSpreadStart()`, i.e. where paging forward from page 0 stops, not `images.length - 1` |
| `Numpad4` | Previous page |
| `Numpad6` | Next page |
| `Alt+↑` / `Numpad8` | Previous zip (cross-folder, sidebar order) |
| `Alt+↓` / `Numpad5` | Next zip (cross-folder, sidebar order) |
| `Numpad0` | Random zip from loaded tree (uniform over zips, with replacement) |
| `Ctrl+F` | Focus sidebar search and select its text (no-op in gallery, but still claims the key so WebView2's find bar doesn't open) |

Zip nav / random use the **whole** tree, not the search results. Inside the search box: `Enter`
opens the first result and blurs, `Esc` clears and blurs — both hand the keys back to the reader.

The 5-spread jumps multiply the **current** spread's stride (`effectiveStride × 5`), so in double
mode a jump from a collapsed (landscape or last-page) spread moves 5 pages, not 10.
Forward jumps clamp to `lastSpreadStart()` (same target as `End`): clamping to `images.length - 1`
shows the final page alone in double mode and shifts every spread's pairing by one on the way back.

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

Virtualised with react-window's `List` (a folder can hold thousands of zips): the tree is
flattened to a `Row[]` (`{kind:"folder"} | {kind:"zip"}`) rebuilt whenever `folders` or
`expanded` changes. Consequences:
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
NFKC-normalized + lowercased (full/half-width fold); `searchText` is precomputed per scan, so a
keystroke over ~4k zips is a few ms. Score per term: 0 text start, 1 word start, 2 mid-word.
"Word start" = after a `BOUNDARY` char (whitespace incl. the `\n` separator, brackets, `| _ - . ~ ・`),
so only the **folder** name start scores 0 — a zip name start scores 1. Only a term's first
occurrence is scored (`indexOf`).
No 繁簡 folding (汉化 ≠ 漢化).

While searching, rows are only matching folders (ranked by best zip, stable) with their matching
zips, all expanded; count shows `matched/total`. Collapsing a result folder goes to
`searchCollapsed` (tagged with its query), **not** `expanded`, so clearing the search restores
the tree untouched. New query → `scrollToRow(0)`; cleared → `scrolledZipRef` reset so the
selection effect scrolls back to the open zip.
