import { convertFileSrc } from "@tauri-apps/api/core";

// Pages are served by the Rust `manga` URI scheme handler rather than shipped
// over IPC as ArrayBuffers, so the webview owns fetching, decode scheduling and
// memory eviction — that is what makes `loading="lazy"` work in scroll mode
// and the gallery.
//
// convertFileSrc("") yields just the protocol origin: "http://manga.localhost/"
// on Windows, "manga://localhost/" elsewhere. Resolved lazily (then cached) so
// importing this module never touches window.__TAURI_INTERNALS__: it exists
// only inside the Tauri webview, and an eager call would throw at import time
// anywhere else (a plain browser tab on the Vite dev server, tests).
let origin: string | null = null;
function protocolOrigin(): string {
  return (origin ??= convertFileSrc("", "manga"));
}

// `version` is the zip's mtime. It makes each URL name exactly one set of
// bytes, so the handler can mark responses immutable: editing a zip mints new
// URLs instead of leaving stale ones cached.
export function pageUrl(zipPath: string, name: string, version: number): string {
  return (
    `${protocolOrigin()}?zip=${encodeURIComponent(zipPath)}` +
    `&name=${encodeURIComponent(name)}&v=${version}`
  );
}

// Gallery covers go through the same scheme, so an <img src> is the whole
// mechanism: the webview caches and evicts them itself. This replaced a hook
// that shipped covers over IPC as ArrayBuffers and hand-rolled a blob-URL LRU
// with revoke bookkeeping, because blob URLs leak unless something frees them.
// `version` is the zip mtime from scan_directory — same immutable-URL trick.
export function thumbUrl(zipPath: string, version: number): string {
  return `${protocolOrigin()}?zip=${encodeURIComponent(zipPath)}&thumb=1&v=${version}`;
}
