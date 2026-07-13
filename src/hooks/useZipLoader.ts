import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

function getMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  if (ext === "bmp") return "image/bmp";
  return "image/jpeg";
}

// Windowed loading: only pages near the reading position are kept in memory,
// so a 500-page zip doesn't hold 500 blobs at once.
const LOAD_BEHIND = 12; // Viewer pre-renders up to 12 pages back (PRELOAD 6 × stride 2)
const LOAD_AHEAD = 20;
const KEEP_SPAN = 40; // revoke blobs further than this from the window center

const WORKERS = 4;

// inFlight/failed sets are keyed by zip+name — bare names collide across zips
// ("001.jpg" exists in every archive), which made pages stick as "Loading…"
// after a fast zip switch.
const keyOf = (zipPath: string, name: string) => `${zipPath}\n${name}`;

export function useZipLoader() {
  const [images, setImages] = useState<string[]>([]);
  const [loadedImages, setLoadedImages] = useState<Map<string, string>>(new Map());
  const [imgLandscape, setImgLandscape] = useState<Map<string, boolean>>(new Map());
  const [failedPages, setFailedPages] = useState<Set<string>>(new Set());
  const [zipError, setZipError] = useState<string | null>(null);

  const activeZipRef = useRef<string | null>(null);
  const imagesRef = useRef<string[]>([]);
  const indexRef = useRef<Map<string, number>>(new Map()); // name → page index
  const loadedRef = useRef<Map<string, string>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const failedRef = useRef<Set<string>>(new Set()); // don't re-request broken pages on every requestWindow
  const queueRef = useRef<string[]>([]); // names to load, nearest-first
  const workersRef = useRef(0);

  const pump = useCallback((zipPath: string) => {
    while (workersRef.current < WORKERS && queueRef.current.length > 0) {
      const name = queueRef.current.shift()!;
      const key = keyOf(zipPath, name);
      if (loadedRef.current.has(name) || inFlightRef.current.has(key) || failedRef.current.has(key)) continue;
      inFlightRef.current.add(key);
      workersRef.current++;
      (async () => {
        try {
          const buffer = await invoke<ArrayBuffer>("load_image", { zipPath, name });
          if (activeZipRef.current !== zipPath) return;
          const url = URL.createObjectURL(new Blob([buffer], { type: getMimeType(name) }));
          loadedRef.current.set(name, url);
          setLoadedImages(new Map(loadedRef.current));
        } catch (e) {
          console.error(`load_image failed: ${name}`, e);
          failedRef.current.add(key);
          if (activeZipRef.current === zipPath) {
            setFailedPages((prev) => new Set(prev).add(name));
          }
        } finally {
          inFlightRef.current.delete(key);
          workersRef.current--;
          if (activeZipRef.current === zipPath) pump(zipPath);
        }
      })();
    }
    // Idle → free pooled archive handles so the zip isn't file-locked on Windows
    if (workersRef.current === 0 && queueRef.current.length === 0 && activeZipRef.current === zipPath) {
      invoke("release_zip_handles", { zipPath }).catch(() => {});
    }
  }, []);

  // Ensure pages around `center` are loaded; optionally revoke far-away blobs.
  // Scroll mode passes revokeOutside=false — dropping already-rendered pages
  // there would collapse layout and make the scrollbar jump.
  const requestWindow = useCallback((center: number, revokeOutside: boolean) => {
    const zipPath = activeZipRef.current;
    const names = imagesRef.current;
    if (!zipPath || names.length === 0) return;

    const c = Math.max(0, Math.min(center, names.length - 1));
    const lo = Math.max(0, c - LOAD_BEHIND);
    const hi = Math.min(names.length - 1, c + LOAD_AHEAD);

    // Rebuild queue nearest-first so the visible page wins
    const wanted: string[] = [];
    for (let d = 0; c + d <= hi || c - d >= lo; d++) {
      if (c + d <= hi) wanted.push(names[c + d]);
      if (d > 0 && c - d >= lo) wanted.push(names[c - d]);
    }
    queueRef.current = wanted.filter(
      (n) =>
        !loadedRef.current.has(n) &&
        !inFlightRef.current.has(keyOf(zipPath, n)) &&
        !failedRef.current.has(keyOf(zipPath, n)),
    );

    if (revokeOutside) {
      let changed = false;
      loadedRef.current.forEach((url, name) => {
        const idx = indexRef.current.get(name) ?? 0;
        if (Math.abs(idx - c) > KEEP_SPAN) {
          URL.revokeObjectURL(url);
          loadedRef.current.delete(name);
          changed = true;
        }
      });
      if (changed) setLoadedImages(new Map(loadedRef.current));
    }

    pump(zipPath);
  }, [pump]);

  const selectZip = useCallback(async (zipPath: string, onSwap?: () => void) => {
    activeZipRef.current = zipPath;
    queueRef.current = []; // stop previous zip's queue; in-flight guarded by activeZipRef
    // Clear imagesRef too — until the atomic swap below, requestWindow would
    // otherwise mix the old zip's names with the new zipPath (a scroll event
    // during the awaits re-queues old names against the new zip)
    imagesRef.current = [];
    failedRef.current = new Set(); // reopening a zip retries pages that failed last time
    setZipError(null);

    let names: string[];
    try {
      names = await invoke<string[]>("list_zip_images", { zipPath });
    } catch (e) {
      if (activeZipRef.current === zipPath) setZipError(String(e));
      return;
    }
    if (activeZipRef.current !== zipPath) return;

    if (names.length === 0) {
      // Swap to empty now — leaving old images up with no error would look
      // like the click did nothing, and Viewer's default empty message
      // ("Select a zip file") would be wrong
      loadedRef.current.forEach((url) => URL.revokeObjectURL(url));
      loadedRef.current = new Map();
      imagesRef.current = [];
      indexRef.current = new Map();
      setLoadedImages(new Map());
      setImgLandscape(new Map());
      setFailedPages(new Set());
      setImages([]);
      setZipError("No images found in this zip");
      onSwap?.();
      return;
    }

    const newLoaded = new Map<string, string>();
    const revokeNew = () => newLoaded.forEach((url) => URL.revokeObjectURL(url));
    try {
      const buf = await invoke<ArrayBuffer>("load_image", { zipPath, name: names[0] });
      if (activeZipRef.current !== zipPath) return;
      newLoaded.set(names[0], URL.createObjectURL(new Blob([buf], { type: getMimeType(names[0]) })));
    } catch {
      // page 0 stays in the load window and gets retried by the workers
    }
    if (activeZipRef.current !== zipPath) { revokeNew(); return; }

    if (newLoaded.size > 0) {
      const preImg = new Image();
      preImg.src = newLoaded.get(names[0])!;
      await preImg.decode().catch(() => {});
    }
    if (activeZipRef.current !== zipPath) { revokeNew(); return; }

    // Atomic swap: revoke old URLs, expose new zip from page 0
    loadedRef.current.forEach((url) => URL.revokeObjectURL(url));
    loadedRef.current = newLoaded;
    imagesRef.current = names;
    indexRef.current = new Map(names.map((n, i) => [n, i]));
    setLoadedImages(new Map(loadedRef.current));
    setImgLandscape(new Map());
    setFailedPages(new Set());
    setImages(names);
    onSwap?.();

    requestWindow(0, false);
  }, [requestWindow]);

  const handleOrientationLoad = useCallback((name: string, isLandscape: boolean) => {
    setImgLandscape((prev) => {
      if (prev.get(name) === isLandscape) return prev;
      const next = new Map(prev);
      next.set(name, isLandscape);
      return next;
    });
  }, []);

  return { images, loadedImages, imgLandscape, failedPages, zipError, selectZip, requestWindow, handleOrientationLoad };
}
