import { useCallback, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pageUrl } from "../utils/pageUrl";

interface ZipListing {
  names: string[];
  mtime: number;
}

interface OpenZip {
  path: string;
  mtime: number;
  names: string[];
}

const NO_IMAGES: string[] = []; // stable identity so effects don't refire

// Pages are plain <img src> pointing at the `manga` URI scheme (see
// utils/pageUrl). The webview handles fetching, decode order and eviction, so
// this hook only tracks *which* pages exist and what has been learned about
// them — no load queue, no blob URLs, no revoke bookkeeping.
export function useZipLoader() {
  const [zip, setZip] = useState<OpenZip | null>(null);
  const [imgLandscape, setImgLandscape] = useState<Map<string, boolean>>(new Map());
  const [failedPages, setFailedPages] = useState<Set<string>>(new Set());
  const [zipError, setZipError] = useState<string | null>(null);

  // Guards against a slow listing for zip A landing after the user opened B
  const activeZipRef = useRef<string | null>(null);

  const selectZip = useCallback(async (path: string, onSwap?: () => void) => {
    activeZipRef.current = path;
    setZipError(null);

    let listing: ZipListing;
    try {
      listing = await invoke<ZipListing>("list_zip_images", { zipPath: path });
    } catch (e) {
      if (activeZipRef.current !== path) return;
      setZip(null);
      setImgLandscape(new Map());
      setFailedPages(new Set());
      setZipError(String(e));
      onSwap?.();
      return;
    }
    if (activeZipRef.current !== path) return;

    const swap = () => {
      setZip({ path, mtime: listing.mtime, names: listing.names });
      setImgLandscape(new Map());
      setFailedPages(new Set());
      onSwap?.();
    };

    if (listing.names.length === 0) {
      // Swap to empty anyway — leaving the old pages up with no error would
      // look like the click did nothing, and Viewer's default empty message
      // ("Select a zip file") would be wrong here
      swap();
      setZipError("No images found in this zip");
      return;
    }

    // Decode page 0 before swapping so the previous zip stays on screen instead
    // of flashing an empty viewer. The <img> that renders next hits the
    // webview's cache (page URLs are immutable), so this is not a double fetch.
    const first = new Image();
    first.src = pageUrl(path, listing.names[0], listing.mtime);
    await first.decode().catch(() => {}); // failure resolves in the <img>'s onError
    if (activeZipRef.current !== path) return;

    swap();
  }, []);

  const handleOrientationLoad = useCallback((name: string, isLandscape: boolean) => {
    setImgLandscape((prev) => {
      if (prev.get(name) === isLandscape) return prev;
      const next = new Map(prev);
      next.set(name, isLandscape);
      return next;
    });
  }, []);

  const handlePageError = useCallback((name: string) => {
    setFailedPages((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
  }, []);

  const srcFor = useCallback(
    (name: string) => (zip ? pageUrl(zip.path, name, zip.mtime) : ""),
    [zip],
  );

  const images = zip?.names ?? NO_IMAGES;

  return useMemo(
    () => ({
      images,
      imgLandscape,
      failedPages,
      zipError,
      selectZip,
      handleOrientationLoad,
      handlePageError,
      srcFor,
    }),
    [images, imgLandscape, failedPages, zipError, selectZip, handleOrientationLoad, handlePageError, srcFor],
  );
}
