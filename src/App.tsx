import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { Store } from "@tauri-apps/plugin-store";
import { restoreStateCurrent, StateFlags } from "@tauri-apps/plugin-window-state";
import { FolderEntry, ViewMode } from "./types";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

function getMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}
import { Sidebar } from "./components/Sidebar";
import { Viewer } from "./components/Viewer";
import "./App.css";

const STORE_FILE = "settings.json";
const KEY_LAST_DIR = "lastDir";
const KEY_VIEW_MODE = "viewMode";

function App() {
  const [folderTree, setFolderTree] = useState<FolderEntry[]>([]);
  const [selectedZip, setSelectedZip] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("single");
  const [loadedImages, setLoadedImages] = useState<Map<string, string>>(new Map());
  const [isDragOver, setIsDragOver] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  // Tracks which zip's stream is active — stale messages from a previous zip are dropped
  const activeZipRef = useRef<string | null>(null);
  const loadedRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    restoreStateCurrent(StateFlags.ALL).catch(() => {});

    Store.load(STORE_FILE, { defaults: {} }).then(async (store) => {
      const savedMode = await store.get<ViewMode>(KEY_VIEW_MODE);
      if (savedMode) setViewMode(savedMode);

      const lastDir = await store.get<string>(KEY_LAST_DIR);
      if (!lastDir) return;
      try {
        const tree = await invoke<FolderEntry[]>("scan_directory", { path: lastDir });
        setFolderTree(tree);
      } catch {
        // dir no longer exists
      }
    }).catch(() => {});
  }, []);

  const changeViewMode = useCallback(async (mode: ViewMode) => {
    setViewMode(mode);
    const store = await Store.load(STORE_FILE, { defaults: {} });
    await store.set(KEY_VIEW_MODE, mode);
    await store.save();
  }, []);

  const scanDir = useCallback(async (dir: string) => {
    const tree = await invoke<FolderEntry[]>("scan_directory", { path: dir });
    setFolderTree(tree);
    const store = await Store.load(STORE_FILE, { defaults: {} });
    await store.set(KEY_LAST_DIR, dir);
    await store.save();
  }, []);

  const selectRoot = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || typeof dir !== "string") return;
    try { await scanDir(dir); } catch (e) { console.error(e); }
  };

  const selectZip = useCallback(async (zipPath: string) => {
    // Revoke previous blob URLs to free memory
    loadedRef.current.forEach((url) => URL.revokeObjectURL(url));

    activeZipRef.current = zipPath;
    loadedRef.current = new Map();
    setSelectedZip(zipPath);
    setLoadedImages(new Map());
    setCurrentPage(0);
    setImages([]);
    setZipError(null);

    let names: string[];
    try {
      names = await invoke<string[]>("list_zip_images", { zipPath });
    } catch (e) {
      if (activeZipRef.current === zipPath) setZipError(String(e));
      return;
    }
    if (activeZipRef.current !== zipPath) return;
    setImages(names);

    // Load images 4 at a time; each gets raw bytes → Blob URL (no base64)
    const CONCURRENCY = 4;
    let i = 0;
    const loadNext = async () => {
      while (i < names.length) {
        if (activeZipRef.current !== zipPath) return;
        const idx = i++;
        const name = names[idx];
        try {
          const buffer = await invoke<ArrayBuffer>("load_image", { zipPath, name });
          if (activeZipRef.current !== zipPath) return;
          const url = URL.createObjectURL(new Blob([buffer], { type: getMimeType(name) }));
          loadedRef.current.set(name, url);
          setLoadedImages(new Map(loadedRef.current));
        } catch (e) {
          console.error(`load_image failed: ${name}`, e);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, loadNext));
  }, []);

  // Drag-and-drop: folder → open as root; zip/cbz → open directly
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") {
        setIsDragOver(true);
      } else if (p.type === "leave") {
        setIsDragOver(false);
      } else if (p.type === "drop") {
        setIsDragOver(false);
        const path = p.paths[0];
        if (!path) return;
        const lower = path.toLowerCase();
        if (lower.endsWith(".zip") || lower.endsWith(".cbz")) {
          selectZip(path);
        } else {
          scanDir(path).catch(() => {});
        }
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [scanDir, selectZip]);

  const stride = viewMode === "double" ? 2 : 1;

  const goNext = useCallback(() => {
    setCurrentPage((p) => Math.min(p + stride, images.length - 1));
  }, [stride, images.length]);

  const goPrev = useCallback(() => {
    setCurrentPage((p) => Math.max(p - stride, 0));
  }, [stride]);

  const flat = folderTree.flatMap((f) => f.zip_files.map((z) => z.path));
  const zipIdx = selectedZip ? flat.indexOf(selectedZip) : -1;

  const navigateZip = (delta: number) => {
    const next = zipIdx + delta;
    if (next >= 0 && next < flat.length) selectZip(flat[next]);
  };

  const jumpPage = (delta: number) => {
    if (viewMode === "scroll") return;
    setCurrentPage((p) => Math.max(0, Math.min(p + delta, images.length - 1)));
  };

  useKeyboardShortcuts([
    { code: "Numpad0", handler: () => {
      if (flat.length === 0) return;
      selectZip(flat[Math.floor(Math.random() * flat.length)]);
    }},
    { key: "ArrowUp",   alt: true, handler: () => navigateZip(-1) },
    { key: "ArrowDown", alt: true, handler: () => navigateZip(+1) },
    { code: "Numpad8",             handler: () => navigateZip(-1) },
    { code: "Numpad5",             handler: () => navigateZip(+1) },
    { code: "PageUp",              handler: () => jumpPage(-stride * 5) },
    { code: "PageDown",            handler: () => jumpPage(+stride * 5) },
    { code: "Numpad4",             handler: () => { if (viewMode !== "scroll") goPrev(); } },
    { code: "Numpad6",             handler: () => { if (viewMode !== "scroll") goNext(); } },
    { key: "ArrowRight",           handler: () => { if (viewMode !== "scroll") goNext(); } },
    { key: "ArrowDown",            handler: () => { if (viewMode !== "scroll") goNext(); } },
    { key: "ArrowLeft",            handler: () => { if (viewMode !== "scroll") goPrev(); } },
    { key: "ArrowUp",              handler: () => { if (viewMode !== "scroll") goPrev(); } },
    { key: " ",                    handler: () => { if (viewMode !== "scroll") goNext(); } },
  ]);

  const totalPages =
    viewMode === "double" ? Math.ceil(images.length / 2) : images.length;
  const displayPage =
    viewMode === "double" ? Math.floor(currentPage / 2) + 1 : currentPage + 1;

  return (
    <div className="app">
      {isDragOver && <div className="drag-overlay">Drop folder or zip to open</div>}
      <div className="toolbar">
        <button className="btn-primary" onClick={selectRoot}>
          Open Directory
        </button>
        <div className="mode-group">
          {(["single", "double", "scroll"] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={`mode-btn${viewMode === m ? " mode-active" : ""}`}
              onClick={() => changeViewMode(m)}
            >
              {m === "single" ? "Single" : m === "double" ? "Double" : "Scroll"}
            </button>
          ))}
        </div>
        <div className="toolbar-spacer" />
        {images.length > 0 && viewMode !== "scroll" && (
          <div className="nav-group">
            <button className="nav-btn" onClick={goPrev} disabled={currentPage === 0}>
              ←
            </button>
            <span className="page-info">
              {displayPage} / {totalPages}
            </span>
            <button
              className="nav-btn"
              onClick={goNext}
              disabled={currentPage >= images.length - 1}
            >
              →
            </button>
          </div>
        )}
        {images.length > 0 && viewMode === "scroll" && (
          <span className="page-info">{images.length} pages</span>
        )}
      </div>

      <div className="layout">
        <Sidebar
          folders={folderTree}
          selectedZip={selectedZip}
          onSelectZip={selectZip}
        />
        <Viewer
          images={images}
          currentPage={currentPage}
          viewMode={viewMode}
          loadedUrls={loadedImages}
          error={zipError}
          zipKey={selectedZip}
        />
      </div>
    </div>
  );
}

export default App;
