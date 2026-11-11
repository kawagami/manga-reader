---
paths:
  - "src-tauri/**"
---

# Backend (src-tauri)

See the cross-layer invariants in the root CLAUDE.md — URL format, immutability, and the gates are
shared with the frontend.

## Rust crates (src-tauri/Cargo.toml)
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

## Commands (src-tauri/src/lib.rs)

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

Registered with `register_asynchronous_uri_scheme_protocol("manga", …)`. The webview owns
fetching, decode scheduling and memory eviction — that is what makes `loading="lazy"` viable in
scroll mode and the gallery.

The handler branches on `thumb` **before** taking a permit, because the two paths need separate
caps: a gallery scroll must not eat the page budget, and a thumb costs a full-size decode.

### `serve_page`
Two gates before any I/O — 403 for non-`is_page_entry` names, and 403 unless `zip` is in
`OPENED_ZIPS` (without it the scheme is a read primitive for **any** zip on disk, since the path
comes straight off the URL). Then takes an archive from the pool, reads the entry, returns it
with the right `Content-Type` and `Cache-Control: max-age=31536000, immutable`.
Concurrency capped at 6 (`PAGE_SEM`); the webview otherwise fires a request per `<img>`.

### `serve_thumb`
JPEG thumbnail (≤150×200) of the zip's first page. Gate is `is_scanned_zip`, **not**
`OPENED_ZIPS`. `SCAN_ROOTS` is an LRU of the last 4 roots passed to `scan_directory`; the check is
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
reparses its central directory.

`THUMBS_DIR` is resolved once in `.setup()`: the protocol handler has no `AppHandle`, and
re-resolving `app_cache_dir()` per request would stat the cache dir on every gallery cell.
Startup sweep (`clean_thumb_cache`, spawned in `.setup()`): deletes thumbs older than 30 days.

`read_entry` caps decompressed output at `MAX_ENTRY_BYTES` (128 MB) via `Read::take` — `alloc_hint`
only bounds the *initial* Vec, so an entry claiming 1 KB can still inflate to gigabytes and OOM.
Reads one byte past the cap so oversized entries error instead of truncating into a corrupt image.

## `OPENED_ZIPS` (the page gate) vs `CURRENT_ZIP` (pool ownership)
Two different lifetimes, hence two statics. `CURRENT_ZIP` must be single-valued — the pool caches
handles for one zip only. The gate must **not** be: `list_zip_images` moves `CURRENT_ZIP` at the
*start* of a switch, but the frontend keeps the previous zip on screen until the listing and
page-0 decode land. Gating on `CURRENT_ZIP` 403s every page of the zip actually being read during
that window, and gallery → double mode remounts the entire paged view inside it (`selectZip` is
async, `changeViewMode("double")` is not), so every preloaded `<img>` in that view (up to ~38 in
double mode) fails at once. `OPENED_ZIPS` is an LRU of the last 4 zips passed to
`list_zip_images`; arbitrary paths are still rejected, which is the property that matters.

## Archive pool + Windows file lock
Pool: global `Mutex<Vec<(path, ZipArchive)>>`, max 4 handles, current zip only — avoids
reparsing the central directory per page while keeping 4-way read parallelism. `CURRENT_ZIP`
(set by `list_zip_images`) rejects stale returns from a previously opened zip.

Idle pooled handles keep the zip file locked on Windows (blocks delete/rename in Explorer).
With the webview driving requests there is no frontend "queue drained" moment to hook, so
`spawn_pool_reaper` wakes every 1.5 s and clears the pool once `LAST_READ` is ≥1.5 s old — so
handles are released 1.5–3 s after the last read.

All statics use `lock_ok()` (`unwrap_or_else(|e| e.into_inner())`) — a panicking reader
would otherwise poison the mutex and turn every later page request into a panic.

## Capabilities (src-tauri/capabilities/default.json)
```json
["core:default", "opener:default", "dialog:allow-open", "store:default", "window-state:default"]
```

## CSP (tauri.conf.json → app.security)
`csp` (prod) and `devCsp` are both set — `null` would leave the `manga://` read gate as the only
thing standing between injected content and the filesystem. Allowances that matter:
`img-src` needs `manga:`/`http://manga.localhost` (pages **and** covers; no `blob:` — nothing uses
object URLs; `asset:`/`http://asset.localhost` and `data:` are Tauri's defaults, kept but unused);
`style-src 'unsafe-inline'` for Vite's injected `<style>` (only needed under `pnpm tauri dev` —
the prod build extracts CSS to a file — but kept in `csp` too, harmlessly); `connect-src` needs
`ipc:`/`http://ipc.localhost` for every `invoke`. `devCsp` adds `'unsafe-inline' 'unsafe-eval'` for
the react-refresh preamble and `ws://localhost:1420` + `http://localhost:1420` for the dev server
and HMR. Tauri's own init script is injected at the WebView level, not as a `<script>` tag, so it
isn't subject to this.
