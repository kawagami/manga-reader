import { useState, useEffect, useRef, useCallback } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderEntry } from "../types";

interface SidebarProps {
  folders: FolderEntry[];
  selectedZip: string | null;
  onSelectZip: (path: string) => void;
}

interface ContextMenu {
  x: number;
  y: number;
  path: string;
}

export function Sidebar({ folders, selectedZip, onSelectZip }: SidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const scrolledZipRef = useRef<string | null>(null);

  // Auto-expand the folder that contains the newly selected zip
  useEffect(() => {
    if (!selectedZip) return;
    const parent = folders.find((f) =>
      f.zip_files.some((z) => z.path === selectedZip)
    );
    if (!parent) return;
    setExpanded((prev) => {
      if (prev.has(parent.path)) return prev;
      const next = new Set(prev);
      next.add(parent.path);
      return next;
    });
  }, [selectedZip, folders]);

  // Scroll selected item into view after expansion renders.
  // `expanded` is in deps so this fires after auto-expand, but guard with
  // scrolledZipRef so manual folder toggles don't re-scroll to the selection.
  useEffect(() => {
    if (!selectedZip || scrolledZipRef.current === selectedZip) return;
    const el = sidebarRef.current?.querySelector<HTMLElement>("[data-selected]");
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    scrolledZipRef.current = selectedZip;
  }, [selectedZip, expanded]);

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => setCtxMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
    };
  }, [ctxMenu]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const onZipContextMenu = useCallback(
    (e: React.MouseEvent, zipPath: string) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, path: zipPath });
    },
    []
  );

  const openLocation = useCallback(async (path: string) => {
    setCtxMenu(null);
    await revealItemInDir(path);
  }, []);

  if (folders.length === 0) {
    return (
      <div className="sidebar sidebar-empty">
        <span>Select a directory to begin</span>
      </div>
    );
  }

  return (
    <>
      <div className="sidebar" ref={sidebarRef}>
        {folders.map((folder) => (
          <div key={folder.path} className="folder">
            <div className="folder-header" onClick={() => toggle(folder.path)}>
              <span className="folder-arrow">
                {expanded.has(folder.path) ? "▼" : "▶"}
              </span>
              <span className="folder-name" title={folder.name}>
                {folder.name}
              </span>
              <span className="folder-count">{folder.zip_files.length}</span>
            </div>
            {expanded.has(folder.path) && (
              <div className="folder-files">
                {folder.zip_files.map((zip) => (
                  <div
                    key={zip.path}
                    data-selected={selectedZip === zip.path ? "" : undefined}
                    className={`zip-item${selectedZip === zip.path ? " zip-selected" : ""}`}
                    onClick={() => onSelectZip(zip.path)}
                    onContextMenu={(e) => onZipContextMenu(e, zip.path)}
                    title={zip.name}
                  >
                    {zip.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ctx-item" onClick={() => openLocation(ctxMenu.path)}>
            Open file location
          </div>
        </div>
      )}
    </>
  );
}
