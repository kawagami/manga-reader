import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Covers are blob URLs and must be revoked by hand. Scrolling a large library
// past thousands of cards would otherwise pin every cover ever seen, so keep a
// bounded LRU — evicted covers reload from the Rust disk cache in milliseconds.
const MAX_COVERS = 600;

// Covers arrive one request at a time. Committing each one copies the whole Map
// and re-renders every visible card, which is O(n²) over a full library scroll;
// batch a short window's worth into one commit instead.
const FLUSH_MS = 50;

export function useCoverLoader() {
  const [covers, setCovers] = useState<Map<string, string>>(new Map());

  const coversRef = useRef<Map<string, string>>(new Map());
  const orderRef = useRef<string[]>([]); // LRU, oldest first
  const loadingRef = useRef<Set<string>>(new Set());
  const failedRef = useRef<Set<string>>(new Set()); // don't re-request broken zips on every scroll
  const genRef = useRef(0); // bumped per root change; invalidates in-flight loads
  const flushRef = useRef<number | undefined>(undefined);

  const scheduleFlush = useCallback(() => {
    if (flushRef.current !== undefined) return;
    flushRef.current = window.setTimeout(() => {
      flushRef.current = undefined;
      setCovers(new Map(coversRef.current));
    }, FLUSH_MS);
  }, []);

  // The gallery re-requests every visible cover on each render pass, so touching
  // on cache hits keeps on-screen covers at the young end of the LRU
  const touch = useCallback((zipPath: string) => {
    const i = orderRef.current.indexOf(zipPath);
    if (i >= 0) orderRef.current.splice(i, 1);
    orderRef.current.push(zipPath);
  }, []);

  const resetCovers = useCallback(() => {
    genRef.current++;
    coversRef.current.forEach((url) => URL.revokeObjectURL(url));
    coversRef.current = new Map();
    orderRef.current = [];
    loadingRef.current.clear();
    failedRef.current.clear();
    window.clearTimeout(flushRef.current);
    flushRef.current = undefined;
    setCovers(new Map());
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(flushRef.current);
      coversRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  const loadCover = useCallback(
    async (zipPath: string): Promise<void> => {
      if (coversRef.current.has(zipPath)) {
        touch(zipPath);
        return;
      }
      if (loadingRef.current.has(zipPath) || failedRef.current.has(zipPath)) return;

      const gen = genRef.current;
      loadingRef.current.add(zipPath);
      try {
        const buffer = await invoke<ArrayBuffer>("load_cover_thumb", { zipPath });
        if (gen !== genRef.current) return; // root changed while loading
        const url = URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
        coversRef.current.set(zipPath, url);
        touch(zipPath);
        while (orderRef.current.length > MAX_COVERS) {
          const evicted = orderRef.current.shift()!;
          const old = coversRef.current.get(evicted);
          if (old) {
            URL.revokeObjectURL(old);
            coversRef.current.delete(evicted);
          }
        }
        scheduleFlush();
      } catch (e) {
        console.error(`loadCover failed: ${zipPath}`, e);
        if (gen === genRef.current) failedRef.current.add(zipPath);
      } finally {
        loadingRef.current.delete(zipPath);
      }
    },
    [touch, scheduleFlush],
  );

  return { covers, loadCover, resetCovers };
}
