import { useCallback, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { DupeProgress, DupeReport } from "../types";

// Called from App, not from the Duplicates view: like the sidebar state, the
// report has to survive the view unmounting while the user opens a zip to
// compare two candidates.
export function useDuplicates() {
  const [report, setReport] = useState<DupeReport | null>(null);
  const [scannedRoot, setScannedRoot] = useState<string | null>(null);
  const [progress, setProgress] = useState<DupeProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Paths moved to the Recycle Bin since the last scan. The view filters on
  // this instead of rewriting the report, so indices into `items` stay valid.
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const runRef = useRef(0);

  const scan = useCallback(async (root: string) => {
    const run = ++runRef.current;
    setScanning(true);
    setError(null);
    setProgress(null);
    const ch = new Channel<DupeProgress>();
    ch.onmessage = (p) => {
      if (runRef.current === run) setProgress(p);
    };
    try {
      const r = await invoke<DupeReport>("find_duplicates", { path: root, onProgress: ch });
      if (runRef.current !== run) return;
      setReport(r);
      setScannedRoot(root);
      setDeleted(new Set());
    } catch (e) {
      if (runRef.current === run) setError(String(e));
    } finally {
      if (runRef.current === run) setScanning(false);
    }
  }, []);

  const markDeleted = useCallback((path: string) => {
    setDeleted((prev) => new Set(prev).add(path));
  }, []);

  return { report, scannedRoot, progress, scanning, error, deleted, scan, markDeleted };
}

export type DuplicatesState = ReturnType<typeof useDuplicates>;
