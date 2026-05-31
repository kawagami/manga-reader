import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { restoreStateCurrent, StateFlags } from "@tauri-apps/plugin-window-state";
import { FolderEntry, ViewMode } from "./types";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useZipLoader } from "./hooks/useZipLoader";
import { saveSetting, loadSetting } from "./utils/store";
import { Sidebar } from "./components/Sidebar";
import { Viewer } from "./components/Viewer";
import { Gallery } from "./components/Gallery";
import "./App.css";

const KEY_LAST_DIR = "lastDir";
const KEY_VIEW_MODE = "viewMode";

function App() {
  const [folderTree, setFolderTree] = useState<FolderEntry[]>([]);
  const [selectedZip, setSelectedZip] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("single");
  const [isDragOver, setIsDragOver] = useState(false);
  const [coverImages, setCoverImages] = useState<Map<string, string>>(new Map());

  const coverImagesRef = useRef<Map<string, string>>(new Map());
  const loadingCoversRef = useRef<Set<string>>(new Set());

  const { images, loadedImages, imgLandscape, zipError, selectZip: loadZip, handleOrientationLoad } = useZipLoader();

  useEffect(() => {
    restoreStateCurrent(StateFlags.ALL).catch(() => {});
    (async () => {
      const savedMode = await loadSetting<ViewMode>(KEY_VIEW_MODE);
      if (savedMode) setViewMode(savedMode);
      const lastDir = await loadSetting<string>(KEY_LAST_DIR);
      if (!lastDir) return;
      try {
        const tree = await invoke<FolderEntry[]>("scan_directory", { path: lastDir });
        setFolderTree(tree);
      } catch {
        // dir no longer exists
      }
    })().catch(() => {});
  }, []);

  const changeViewMode = useCallback(async (mode: ViewMode) => {
    setViewMode(mode);
    await saveSetting(KEY_VIEW_MODE, mode);
  }, []);

  const scanDir = useCallback(async (dir: string) => {
    coverImagesRef.current.forEach((url) => URL.revokeObjectURL(url));
    coverImagesRef.current = new Map();
    loadingCoversRef.current.clear();
    setCoverImages(new Map());
    const tree = await invoke<FolderEntry[]>("scan_directory", { path: dir });
    setFolderTree(tree);
    await saveSetting(KEY_LAST_DIR, dir);
  }, []);

  const loadCover = useCallback(async (zipPath: string): Promise<void> => {
    if (coverImagesRef.current.has(zipPath) || loadingCoversRef.current.has(zipPath)) return;
    loadingCoversRef.current.add(zipPath);
    try {
      const buffer = await invoke<ArrayBuffer>("load_cover_thumb", { zipPath });
      const url = URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
      coverImagesRef.current.set(zipPath, url);
      setCoverImages(new Map(coverImagesRef.current));
    } catch (e) {
      console.error(`loadCover failed: ${zipPath}`, e);
    } finally {
      loadingCoversRef.current.delete(zipPath);
    }
  }, []);

  const selectRoot = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || typeof dir !== "string") return;
    try { await scanDir(dir); } catch (e) { console.error(e); }
  };

  const selectZip = useCallback(async (zipPath: string) => {
    setSelectedZip(zipPath);
    await loadZip(zipPath, () => setCurrentPage(0));
  }, [loadZip]);

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
  const effectiveStride =
    viewMode === "double" && imgLandscape.get(images[currentPage]) === true ? 1 : stride;

  const goNext = useCallback(() => {
    setCurrentPage((p) => Math.min(p + effectiveStride, images.length - 1));
  }, [effectiveStride, images.length]);

  const goPrev = useCallback(() => {
    setCurrentPage((p) => Math.max(p - effectiveStride, 0));
  }, [effectiveStride]);

  const flat = folderTree.flatMap((f) => f.zip_files.map((z) => z.path));
  const zipIdx = selectedZip ? flat.indexOf(selectedZip) : -1;

  const navigateZip = (delta: number) => {
    const next = zipIdx + delta;
    if (next >= 0 && next < flat.length) selectZip(flat[next]);
  };

  const jumpPage = (delta: number) => {
    if (viewMode === "scroll" || viewMode === "gallery") return;
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
    { code: "PageUp",              handler: () => jumpPage(-effectiveStride * 5) },
    { code: "PageDown",            handler: () => jumpPage(+effectiveStride * 5) },
    { code: "Numpad7",             handler: () => jumpPage(-effectiveStride * 5) },
    { code: "Numpad9",             handler: () => jumpPage(+effectiveStride * 5) },
    { code: "Numpad4",             handler: () => { if (viewMode === "single" || viewMode === "double") goPrev(); } },
    { code: "Numpad6",             handler: () => { if (viewMode === "single" || viewMode === "double") goNext(); } },
    { key: "ArrowRight",           handler: () => { if (viewMode === "single" || viewMode === "double") goNext(); } },
    { key: "ArrowDown",            handler: () => { if (viewMode === "single" || viewMode === "double") goNext(); } },
    { key: "ArrowLeft",            handler: () => { if (viewMode === "single" || viewMode === "double") goPrev(); } },
    { key: "ArrowUp",              handler: () => { if (viewMode === "single" || viewMode === "double") goPrev(); } },
    { key: " ",                    handler: () => { if (viewMode === "single" || viewMode === "double") goNext(); } },
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
          {(["single", "double", "scroll", "gallery"] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={`mode-btn${viewMode === m ? " mode-active" : ""}`}
              onClick={() => changeViewMode(m)}
            >
              {m === "single" ? "Single" : m === "double" ? "Double" : m === "scroll" ? "Scroll" : "Gallery"}
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
        {viewMode === "gallery" ? (
          <Gallery
            folders={folderTree}
            coverImages={coverImages}
            selectedZip={selectedZip}
            onSelectZip={(path) => { selectZip(path); changeViewMode("single"); }}
            onLoadCover={(path) => loadCover(path)}
          />
        ) : (
          <>
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
              imgLandscape={imgLandscape}
              onOrientationLoad={handleOrientationLoad}
              error={zipError}
              zipKey={selectedZip}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default App;
