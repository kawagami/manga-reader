import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { concurrentForEach } from "../utils/concurrentForEach";

function getMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

export function useZipLoader() {
  const [images, setImages] = useState<string[]>([]);
  const [loadedImages, setLoadedImages] = useState<Map<string, string>>(new Map());
  const [imgLandscape, setImgLandscape] = useState<Map<string, boolean>>(new Map());
  const [zipError, setZipError] = useState<string | null>(null);

  const activeZipRef = useRef<string | null>(null);
  const loadedRef = useRef<Map<string, string>>(new Map());
  const cancelRef = useRef<(() => void) | null>(null);

  const selectZip = useCallback(async (zipPath: string, onSwap?: () => void) => {
    activeZipRef.current = zipPath;
    cancelRef.current?.(); // stop previous zip's workers from claiming more pages
    setZipError(null);

    let names: string[];
    try {
      names = await invoke<string[]>("list_zip_images", { zipPath });
    } catch (e) {
      if (activeZipRef.current === zipPath) setZipError(String(e));
      return;
    }
    if (activeZipRef.current !== zipPath) return;

    const newLoaded = new Map<string, string>();
    const revokeNew = () => newLoaded.forEach((url) => URL.revokeObjectURL(url));
    if (names.length > 0) {
      try {
        const buf = await invoke<ArrayBuffer>("load_image", { zipPath, name: names[0] });
        if (activeZipRef.current !== zipPath) return;
        newLoaded.set(names[0], URL.createObjectURL(new Blob([buf], { type: getMimeType(names[0]) })));
      } catch {
        // proceed without page 0 pre-loaded
      }
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
    setLoadedImages(new Map(loadedRef.current));
    setImgLandscape(new Map());
    setImages(names);
    onSwap?.();

    const { done, cancel } = concurrentForEach(names.slice(1), 4, async (name) => {
      try {
        if (activeZipRef.current !== zipPath) return;
        const buffer = await invoke<ArrayBuffer>("load_image", { zipPath, name });
        if (activeZipRef.current !== zipPath) return;
        const url = URL.createObjectURL(new Blob([buffer], { type: getMimeType(name) }));
        loadedRef.current.set(name, url);
        setLoadedImages(new Map(loadedRef.current));
      } catch (e) {
        console.error(`load_image failed: ${name}`, e);
      }
    });
    cancelRef.current = cancel;
    await done;
  }, []);

  const handleOrientationLoad = useCallback((name: string, isLandscape: boolean) => {
    setImgLandscape((prev) => {
      if (prev.get(name) === isLandscape) return prev;
      const next = new Map(prev);
      next.set(name, isLandscape);
      return next;
    });
  }, []);

  return { images, loadedImages, imgLandscape, zipError, selectZip, handleOrientationLoad };
}
