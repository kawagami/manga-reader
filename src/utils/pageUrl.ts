import { convertFileSrc } from "@tauri-apps/api/core";

// Pages are served by the Rust `manga` URI scheme handler rather than shipped
// over IPC as ArrayBuffers, so the webview owns fetching, decode scheduling and
// memory eviction — that is what makes `loading="lazy"` work in scroll mode.
//
// convertFileSrc("") yields just the protocol origin: "http://manga.localhost/"
// on Windows, "manga://localhost/" elsewhere. Resolved lazily because the Tauri
// internals it reads are injected before the bundle runs, not before import.
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
