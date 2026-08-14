import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { List, RowComponentProps, useListRef } from "react-window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderEntry, ZipFileEntry } from "../types";

// Must match .folder-header / .zip-item in App.css. react-window needs a row's
// height before it renders it, so the CSS pins the height instead of letting
// padding + line-height decide it.
const ROW_H_FOLDER = 31;
const ROW_H_ZIP = 27;

interface SidebarProps {
  folders: FolderEntry[];
  selectedZip: string | null;
  onSelectZip: (path: string) => void;
  // Owned by App: gallery mode unmounts this component, so state held here
  // would be discarded every time the user switched to the covers and back.
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
}

interface ContextMenu {
  x: number;
  y: number;
  path: string;
}

// The tree is flattened to a single row list so it can be virtualised: an
// expanded folder holding a few thousand zips used to put that many <div>s in
// the DOM (the gallery has had react-window all along; the sidebar hadn't).
type Row =
  | { kind: "folder"; folder: FolderEntry; expanded: boolean }
  | { kind: "zip"; zip: ZipFileEntry };

interface RowProps {
  rows: Row[];
  selectedZip: string | null;
  onToggle: (path: string) => void;
  onSelectZip: (path: string) => void;
  onZipContextMenu: (e: React.MouseEvent, path: string) => void;
}

const rowHeight = (index: number, { rows }: RowProps) =>
  rows[index].kind === "folder" ? ROW_H_FOLDER : ROW_H_ZIP;

function SidebarRow({
  index,
  style,
  rows,
  selectedZip,
  onToggle,
  onSelectZip,
  onZipContextMenu,
}: RowComponentProps<RowProps>) {
  const row = rows[index];

  if (row.kind === "folder") {
    const { folder, expanded } = row;
    return (
      <div style={style}>
        <div className="folder-header" onClick={() => onToggle(folder.path)}>
          <span className="folder-arrow">{expanded ? "▼" : "▶"}</span>
          <span className="folder-name" title={folder.name}>
            {folder.name}
          </span>
          <span className="folder-count">{folder.zip_files.length}</span>
        </div>
      </div>
    );
  }

  const { zip } = row;
  const selected = selectedZip === zip.path;
  return (
    <div style={style}>
      <div
        className={`zip-item${selected ? " zip-selected" : ""}`}
        onClick={() => onSelectZip(zip.path)}
        onContextMenu={(e) => onZipContextMenu(e, zip.path)}
        title={zip.name}
      >
        {zip.name}
      </div>
    </div>
  );
}

export function Sidebar({ folders, selectedZip, onSelectZip, expanded, setExpanded }: SidebarProps) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null);
  const listRef = useListRef(null);
  const scrolledZipRef = useRef<string | null>(null);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const folder of folders) {
      const isExpanded = expanded.has(folder.path);
      out.push({ kind: "folder", folder, expanded: isExpanded });
      if (isExpanded) {
        for (const zip of folder.zip_files) out.push({ kind: "zip", zip });
      }
    }
    return out;
  }, [folders, expanded]);

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
  }, [selectedZip, folders, setExpanded]);

  // Scroll the selection into view once its folder has expanded. The row may
  // not be mounted, so this goes through the list's imperative API rather than
  // scrollIntoView on a DOM node. `rows` is in deps so it fires after
  // auto-expand; scrolledZipRef stops manual folder toggles from re-scrolling.
  useEffect(() => {
    if (!selectedZip || scrolledZipRef.current === selectedZip) return;
    const index = rows.findIndex(
      (r) => r.kind === "zip" && r.zip.path === selectedZip
    );
    if (index < 0) return; // folder still collapsed — the effect above fixes that
    listRef.current?.scrollToRow({ index, align: "auto" });
    scrolledZipRef.current = selectedZip;
  }, [selectedZip, rows, listRef]);

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

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, [setExpanded]);

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

  const rowProps: RowProps = useMemo(
    () => ({ rows, selectedZip, onToggle: toggle, onSelectZip, onZipContextMenu }),
    [rows, selectedZip, toggle, onSelectZip, onZipContextMenu]
  );

  if (folders.length === 0) {
    return (
      <div className="sidebar sidebar-empty">
        <span>Select a directory to begin</span>
      </div>
    );
  }

  return (
    <>
      <div className="sidebar">
        <List
          listRef={listRef}
          rowCount={rows.length}
          rowHeight={rowHeight}
          rowComponent={SidebarRow}
          rowProps={rowProps}
          overscanCount={4}
          style={{ height: "100%", width: "100%" }}
        />
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
