import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { DupeItem } from "../types";
import { DuplicatesState } from "../hooks/useDuplicates";
import { thumbUrl } from "../utils/pageUrl";

type Tab = "identical" | "overlap" | "problems";

function fmtSize(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(secs: number): string {
  return secs ? new Date(secs * 1000).toLocaleDateString() : "";
}

function DupeCard({ item, label, busy, onOpen, onTrash }: {
  item: DupeItem;
  label?: string;
  busy: boolean;
  onOpen?: (path: string) => void;
  onTrash: (item: DupeItem) => void;
}) {
  const src = thumbUrl(item.path, item.mtime);
  return (
    <div className="dupe-card">
      <img
        key={src}
        className="dupe-cover"
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={(e) => e.currentTarget.classList.add("cover-failed")}
      />
      <div className="dupe-info">
        {label && <span className="dupe-label">{label}</span>}
        <div className="dupe-name" title={item.path}>{item.name}</div>
        <div className="dupe-meta">
          <span className="dupe-folder">{item.folder}</span>
          <span>{fmtSize(item.size)}</span>
          {item.pages > 0 && <span>{item.pages} pages</span>}
          <span>{fmtDate(item.mtime)}</span>
        </div>
        <div className="dupe-actions">
          {onOpen && <button onClick={() => onOpen(item.path)}>Open</button>}
          <button onClick={() => revealItemInDir(item.path).catch(console.error)}>Show in folder</button>
          <button className="btn-danger" disabled={busy} onClick={() => onTrash(item)}>
            {busy ? "Deleting…" : "Recycle"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  state: DuplicatesState;
  rootDir: string | null;
  onOpen: (path: string) => void;
  onTrashed: (path: string) => void;
  onError: (msg: string) => void;
}

export function Duplicates({ state, rootDir, onOpen, onTrashed, onError }: Props) {
  const { report, scannedRoot, progress, scanning, error, deleted, scan, markDeleted } = state;
  const [tab, setTab] = useState<Tab>("identical");
  const [busy, setBusy] = useState<string | null>(null);

  // Deleted archives drop out of every list; a group left with one member is
  // no longer a duplicate
  const view = useMemo(() => {
    if (!report) return null;
    const alive = (i: number) => !deleted.has(report.items[i].path);
    const identical = report.identical.map((g) => g.filter(alive)).filter((g) => g.length > 1);
    const overlaps = report.overlaps.filter((o) => alive(o.a) && alive(o.b));
    const broken = report.broken.filter((b) => alive(b.item));
    const noImages = report.no_images.filter(alive);
    const reclaim = identical.reduce((sum, g) => {
      const sizes = g.map((i) => report.items[i].size);
      return sum + sizes.reduce((a, b) => a + b, 0) - Math.max(...sizes);
    }, 0);
    return { identical, overlaps, broken, noImages, reclaim };
  }, [report, deleted]);

  const trash = async (item: DupeItem) => {
    const ok = await ask(`Move this archive to the Recycle Bin?\n\n${item.name}\n\nFolder: ${item.folder}`, {
      title: "Delete duplicate",
      kind: "warning",
      okLabel: "Recycle",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    setBusy(item.path);
    try {
      await invoke("trash_zip", { path: item.path });
      markDeleted(item.path);
      onTrashed(item.path);
    } catch (e) {
      onError(`Failed to delete: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  const card = (i: number, label?: string, openable = true) => {
    const item = report!.items[i];
    return (
      <DupeCard
        key={item.path}
        item={item}
        label={label}
        busy={busy === item.path}
        onOpen={openable ? onOpen : undefined}
        onTrash={trash}
      />
    );
  };

  const header = (
    <div className="dupes-header">
      <button
        className="btn-primary"
        disabled={!rootDir || scanning}
        onClick={() => rootDir && scan(rootDir)}
      >
        {report ? "Rescan" : "Find duplicates"}
      </button>
      {scanning && (
        <span className="dupes-status">
          Scanning… {progress ? `${progress.done} / ${progress.total}` : ""}
        </span>
      )}
      {!scanning && report && (
        <span className="dupes-status">
          {report.scanned} zips scanned in {(report.elapsed_ms / 1000).toFixed(1)}s
          {scannedRoot && scannedRoot !== rootDir && " (different directory — rescan)"}
        </span>
      )}
      {error && <span className="dupes-error">{error}</span>}
    </div>
  );

  if (!report || !view) {
    return (
      <div className="dupes">
        {header}
        <div className="dupes-empty">
          {rootDir
            ? "Compares the pages inside every zip (CRC32 from the zip directory, nothing is extracted)."
            : "Open a directory first."}
        </div>
      </div>
    );
  }

  const tabs: [Tab, string][] = [
    ["identical", `Identical (${view.identical.length})`],
    ["overlap", `Overlap (${view.overlaps.length})`],
    ["problems", `Problems (${view.broken.length + view.noImages.length})`],
  ];

  return (
    <div className="dupes">
      {header}
      <div className="dupes-tabs">
        <div className="mode-group">
          {tabs.map(([t, label]) => (
            <button
              key={t}
              className={`mode-btn${tab === t ? " mode-active" : ""}`}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="dupes-hint">
          {tab === "identical" &&
            `Same pages inside, re-zipped or renamed — safe to keep one. Reclaimable: ${fmtSize(view.reclaim)}`}
          {tab === "overlap" &&
            "One archive contains most or all pages of the other (collected edition, extra pages). Check before deleting."}
          {tab === "problems" &&
            "Archives that can't be read (most often a truncated download with no zip directory) and zips without images."}
        </span>
      </div>

      <div className="dupes-list">
        {tab === "identical" &&
          (view.identical.length === 0 ? (
            <div className="dupes-empty">No identical archives.</div>
          ) : (
            view.identical.map((g) => (
              <section key={report.items[g[0]].path} className="dupe-group">
                <div className="dupe-group-title">
                  {report.items[g[0]].pages} pages · {g.length} copies
                </div>
                <div className="dupe-cards">{g.map((i) => card(i))}</div>
              </section>
            ))
          ))}

        {tab === "overlap" &&
          (view.overlaps.length === 0 ? (
            <div className="dupes-empty">No overlapping archives.</div>
          ) : (
            view.overlaps.map((o) => {
              const a = report.items[o.a];
              const b = report.items[o.b];
              const pct = Math.round((o.shared / o.b_unique) * 100);
              return (
                <section key={`${a.path}\n${b.path}`} className="dupe-group">
                  <div className="dupe-group-title">
                    <span className={o.subset ? "dupe-badge dupe-badge-subset" : "dupe-badge"}>
                      {o.subset ? "SUBSET" : `${pct}%`}
                    </span>
                    {o.subset
                      ? `all ${o.b_unique} distinct pages of the smaller one are in the larger (${o.a_unique})`
                      : `${o.shared} of ${o.b_unique} distinct pages shared (larger has ${o.a_unique})`}
                  </div>
                  <div className="dupe-cards">
                    {card(o.a, "Larger")}
                    {card(o.b, o.subset ? "Fully contained in the other" : "Smaller")}
                  </div>
                </section>
              );
            })
          ))}

        {tab === "problems" && (
          <>
            {view.broken.length + view.noImages.length === 0 && (
              <div className="dupes-empty">No problems found.</div>
            )}
            {view.broken.length > 0 && (
              <section className="dupe-group">
                <div className="dupe-group-title">Unreadable ({view.broken.length})</div>
                <div className="dupe-cards">
                  {view.broken.map((b) => card(b.item, b.error, false))}
                </div>
              </section>
            )}
            {view.noImages.length > 0 && (
              <section className="dupe-group">
                <div className="dupe-group-title">No images ({view.noImages.length})</div>
                <div className="dupe-cards">{view.noImages.map((i) => card(i, undefined, false))}</div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
