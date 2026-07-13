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
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | undefined>(undefined);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const coverImagesRef = useRef<Map<string, string>>(new Map());
  const loadingCoversRef = useRef<Set<string>>(new Set());
  const failedCoversRef = useRef<Set<string>>(new Set()); // don't re-request broken zips on every scroll
  const scanGenRef = useRef(0); // bumped per root change; invalidates in-flight cover loads

  const { images, loadedImages, imgLandscape, zipError, selectZip: loadZip, requestWindow, handleOrientationLoad } = useZipLoader();

  // Keep the load window centered on the reading position. Scroll mode keeps
  // already-loaded pages (revoking would collapse layout above the viewport).
  useEffect(() => {
    if (images.length > 0) requestWindow(currentPage, viewMode !== "scroll");
  }, [currentPage, viewMode, images, requestWindow]);

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

  const changeViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    saveSetting(KEY_VIEW_MODE, mode).catch(console.error);
  }, []);

  const scanDir = useCallback(async (dir: string) => {
    // Scan first — on failure (e.g. dropped path is not a directory) current state stays intact
    const tree = await invoke<FolderEntry[]>("scan_directory", { path: dir });
    scanGenRef.current++;
    coverImagesRef.current.forEach((url) => URL.revokeObjectURL(url));
    coverImagesRef.current = new Map();
    loadingCoversRef.current.clear();
    failedCoversRef.current.clear();
    setCoverImages(new Map());
    setFolderTree(tree);
    await saveSetting(KEY_LAST_DIR, dir);
  }, []);

  const loadCover = useCallback(async (zipPath: string): Promise<void> => {
    if (
      coverImagesRef.current.has(zipPath) ||
      loadingCoversRef.current.has(zipPath) ||
      failedCoversRef.current.has(zipPath)
    ) return;
    const gen = scanGenRef.current;
    loadingCoversRef.current.add(zipPath);
    try {
      const buffer = await invoke<ArrayBuffer>("load_cover_thumb", { zipPath });
      if (gen !== scanGenRef.current) return; // root changed while loading
      const url = URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
      coverImagesRef.current.set(zipPath, url);
      setCoverImages(new Map(coverImagesRef.current));
    } catch (e) {
      console.error(`loadCover failed: ${zipPath}`, e);
      if (gen === scanGenRef.current) failedCoversRef.current.add(zipPath);
    } finally {
      loadingCoversRef.current.delete(zipPath);
    }
  }, []);

  const selectRoot = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || typeof dir !== "string") return;
    try {
      await scanDir(dir);
    } catch (e) {
      console.error(e);
      showNotice(`Failed to scan directory: ${e}`);
    }
  };

  const selectZip = useCallback(async (zipPath: string) => {
    setSelectedZip(zipPath);
    await loadZip(zipPath, () => setCurrentPage(0));
  }, [loadZip]);

  // Stable identity so Gallery cells don't re-render on every App render
  const openFromGallery = useCallback((path: string) => {
    selectZip(path);
    changeViewMode("double");
  }, [selectZip, changeViewMode]);

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
          scanDir(path).catch((err) => showNotice(`Failed to scan directory: ${err}`));
        }
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [scanDir, selectZip, showNotice]);

  const stride = viewMode === "double" ? 2 : 1;
  const effectiveStride =
    viewMode === "double" && imgLandscape.get(images[currentPage]) === true ? 1 : stride;

  // Advance only if the next spread starts on a real page — stops the last
  // spread from re-showing its final page alone in double mode
  const canGoNext = currentPage + effectiveStride <= images.length - 1;

  const goNext = useCallback(() => {
    setCurrentPage((p) => {
      const next = p + effectiveStride;
      return next <= images.length - 1 ? next : p;
    });
  }, [effectiveStride, images.length]);

  const goPrev = useCallback(() => {
    setCurrentPage((p) => Math.max(p - effectiveStride, 0));
  }, [effectiveStride]);

  const flat = folderTree.flatMap((f) => f.zip_files.map((z) => z.path));
  const zipIdx = selectedZip ? flat.indexOf(selectedZip) : -1;

  // In gallery mode a keyboard-opened zip has no visible viewer — switch to
  // double mode (same as clicking a card) instead of loading invisibly
  const openZip = (path: string) => {
    selectZip(path);
    if (viewMode === "gallery") changeViewMode("double");
  };

  const navigateZip = (delta: number) => {
    const next = zipIdx + delta;
    if (next >= 0 && next < flat.length) openZip(flat[next]);
  };

  const pagedMode = viewMode === "single" || viewMode === "double";

  // Returning false leaves the event to the browser (native scrolling in scroll mode)
  const jumpPage = (delta: number) => {
    if (!pagedMode) return false;
    setCurrentPage((p) => Math.max(0, Math.min(p + delta, images.length - 1)));
  };

  useKeyboardShortcuts([
    { code: "Numpad0", handler: () => {
      if (flat.length === 0) return;
      openZip(flat[Math.floor(Math.random() * flat.length)]);
    }},
    { key: "ArrowUp",   alt: true, handler: () => navigateZip(-1) },
    { key: "ArrowDown", alt: true, handler: () => navigateZip(+1) },
    { code: "Numpad8",             handler: () => navigateZip(-1) },
    { code: "Numpad5",             handler: () => navigateZip(+1) },
    { code: "PageUp",              handler: () => jumpPage(-effectiveStride * 5) },
    { code: "PageDown",            handler: () => jumpPage(+effectiveStride * 5) },
    { code: "Numpad7",             handler: () => jumpPage(-effectiveStride * 5) },
    { code: "Numpad9",             handler: () => jumpPage(+effectiveStride * 5) },
    { code: "Numpad4",             handler: () => pagedMode ? goPrev() : false },
    { code: "Numpad6",             handler: () => pagedMode ? goNext() : false },
    { key: "ArrowRight",           handler: () => pagedMode ? goNext() : false },
    { key: "ArrowDown",            handler: () => pagedMode ? goNext() : false },
    { key: "ArrowLeft",            handler: () => pagedMode ? goPrev() : false },
    { key: "ArrowUp",              handler: () => pagedMode ? goPrev() : false },
    { key: " ",                    handler: () => pagedMode ? goNext() : false },
  ]);

  // Real page numbers — spread math drifts once a landscape page shifts parity
  const spreadLast = Math.min(currentPage + effectiveStride, images.length);
  const pageLabel =
    spreadLast > currentPage + 1
      ? `${currentPage + 1}–${spreadLast} / ${images.length}`
      : `${currentPage + 1} / ${images.length}`;

  return (
    <div className="app">
      {isDragOver && <div className="drag-overlay">Drop folder or zip to open</div>}
      {notice && <div className="toast">{notice}</div>}
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
        {images.length > 0 && pagedMode && (
          <div className="nav-group">
            <button className="nav-btn" onClick={goPrev} disabled={currentPage === 0}>
              ←
            </button>
            <span className="page-info">{pageLabel}</span>
            <button
              className="nav-btn"
              onClick={goNext}
              disabled={!canGoNext}
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
            onSelectZip={openFromGallery}
            onLoadCover={loadCover}
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
              onVisiblePage={setCurrentPage}
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
