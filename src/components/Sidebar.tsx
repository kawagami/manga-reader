import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { List, RowComponentProps, useListRef } from "react-window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderEntry, ZipFileEntry } from "../types";
import { normalize, parseQuery, matchScore } from "../utils/search";

// Must match .folder-header / .zip-item in App.css. react-window needs a row's
// height before it renders it, so the row box is sized from these constants
// and the CSS just fills it (height: 100%) instead of padding + line-height
// deciding it.
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
  // Also owned by App, for the same reason as `expanded`
  query: string;
  onQueryChange: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
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
  | { kind: "folder"; folder: FolderEntry; expanded: boolean; matched: number | null }
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
    const { folder, expanded, matched } = row;
    return (
      <div style={style}>
        <div className="folder-header" onClick={() => onToggle(folder.path)}>
          <span className="folder-arrow">{expanded ? "▼" : "▶"}</span>
          <span className="folder-name" title={folder.name}>
            {folder.name}
          </span>
          <span className="folder-count">
            {matched === null ? folder.zip_files.length : `${matched}/${folder.zip_files.length}`}
          </span>
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

export function Sidebar({
  folders,
  selectedZip,
  onSelectZip,
  expanded,
  setExpanded,
  query,
  onQueryChange,
  searchRef,
}: SidebarProps) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null);
  const listRef = useListRef(null);
  const scrolledZipRef = useRef<string | null>(null);

  const terms = useMemo(() => parseQuery(query), [query]);
  const searching = terms.length > 0;

  // Search text per zip is "folder\nzip", so a term can hit either the author
  // folder or the file name. NFKC over the whole library is paid once per
  // scan, not per keystroke.
  const searchText = useMemo(
    () => folders.map((f) => {
      const folderName = normalize(f.name);
      return f.zip_files.map((z) => `${folderName}\n${normalize(z.name)}`);
    }),
    [folders],
  );

  // Search results show every matching folder expanded. Collapsing one while
  // searching is tracked here rather than in `expanded`, so clearing the
  // search restores the tree exactly as it was. Tagged with the query it
  // belongs to: a new query starts with everything open again.
  const [searchCollapsed, setSearchCollapsed] = useState({ query: "", paths: new Set<string>() });
  const collapsedNow = searchCollapsed.query === query ? searchCollapsed.paths : null;

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (!searching) {
      for (const folder of folders) {
        const isExpanded = expanded.has(folder.path);
        out.push({ kind: "folder", folder, expanded: isExpanded, matched: null });
        if (isExpanded) {
          for (const zip of folder.zip_files) out.push({ kind: "zip", zip });
        }
      }
      return out;
    }

    // Folders ranked by their best zip, zips by score. Array.sort is stable,
    // so ties keep the tree's natural order.
    type Hit = { zip: ZipFileEntry; score: number };
    const hits: { folder: FolderEntry; zips: Hit[] }[] = [];
    folders.forEach((folder, fi) => {
      const zips: Hit[] = [];
      folder.zip_files.forEach((zip, zi) => {
        const score = matchScore(searchText[fi][zi], terms);
        if (score >= 0) zips.push({ zip, score });
      });
      if (zips.length === 0) return;
      zips.sort((a, b) => a.score - b.score);
      hits.push({ folder, zips });
    });
    hits.sort((a, b) => a.zips[0].score - b.zips[0].score);

    for (const { folder, zips } of hits) {
      const isExpanded = !collapsedNow?.has(folder.path);
      out.push({ kind: "folder", folder, expanded: isExpanded, matched: zips.length });
      if (isExpanded) {
        for (const { zip } of zips) out.push({ kind: "zip", zip });
      }
    }
    return out;
  }, [folders, expanded, searching, searchText, terms, collapsedNow]);

  // New query → results start from the top. Cleared → let the selection
  // effect below scroll back to the open zip (declared first so it runs first).
  useEffect(() => {
    if (!searching) scrolledZipRef.current = null;
    else if (rows.length > 0) listRef.current?.scrollToRow({ index: 0, align: "start" });
  }, [terms]); // deliberately not `rows`: collapsing a result folder must not jump to the top

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
    const flip = (prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    };
    if (searching) {
      setSearchCollapsed((prev) => ({
        query,
        paths: flip(prev.query === query ? prev.paths : new Set()),
      }));
    } else {
      setExpanded(flip);
    }
  }, [searching, query, setExpanded]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // Enter/Esc confirming an IME candidate
    if (e.key === "Escape") {
      e.preventDefault();
      onQueryChange("");
      e.currentTarget.blur();
    } else if (e.key === "Enter") {
      const first = rows.find((r) => r.kind === "zip");
      if (!first) return;
      onSelectZip(first.zip.path);
      // Hand the keyboard back to the reader so arrows turn pages again
      e.currentTarget.blur();
    }
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
        <input
          ref={searchRef}
          className="sidebar-search"
          type="search"
          placeholder="Search (Ctrl+F)"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onSearchKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="sidebar-list">
          {searching && rows.length === 0 ? (
            <div className="sidebar-no-match">No matches</div>
          ) : (
            <List
              listRef={listRef}
              rowCount={rows.length}
              rowHeight={rowHeight}
              rowComponent={SidebarRow}
              rowProps={rowProps}
              overscanCount={4}
              style={{ height: "100%", width: "100%" }}
            />
          )}
        </div>
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
