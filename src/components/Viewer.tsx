import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ViewMode } from "../types";
import { spreadStride } from "../utils/spread";

interface ViewerProps {
  images: string[];
  currentPage: number;
  viewMode: ViewMode;
  srcFor: (name: string) => string;
  imgLandscape: Map<string, boolean>;
  failedPages: Set<string>;
  onOrientationLoad: (name: string, isLandscape: boolean) => void;
  onPageError: (name: string) => void;
  onVisiblePage?: (index: number) => void; // scroll mode: page index at viewport center
  error?: string | null;
}

export function Viewer({
  images,
  currentPage,
  viewMode,
  srcFor,
  imgLandscape,
  failedPages,
  onOrientationLoad,
  onPageError,
  onVisiblePage,
  error,
}: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset scroll when the page list swaps (new zip), not when the sidebar
  // selection changes — selection updates before the load finishes, and
  // resetting then scrolls the still-visible old zip to the top. Layout
  // effect: reset must land before the new pages paint.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [images]);

  // Track the page at the viewport centre so switching scroll → single keeps
  // the reading position. An IntersectionObserver whose root is collapsed to a
  // line at the centre reports this in O(1); the old scroll handler walked
  // every page element on each frame and read offsetTop, forcing layout.
  useEffect(() => {
    if (viewMode !== "scroll" || !onVisiblePage) return;
    const root = scrollRef.current;
    if (!root) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (!Number.isNaN(page)) onVisiblePage(page);
          break;
        }
      },
      { root, rootMargin: "-50% 0px -50% 0px", threshold: 0 },
    );
    root.querySelectorAll<HTMLElement>(".scroll-page").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [viewMode, images, onVisiblePage]);

  // Scrolling updates currentPage on every page boundary, but the scroll list
  // doesn't depend on it — memoising keeps React from reconciling all N page
  // nodes on each tick. Same element references = children skipped entirely.
  const scrollPages = useMemo(
    () =>
      images.map((name, idx) => {
        const src = srcFor(name);
        return (
          // Keyed by src, not name: "001.jpg" exists in every archive, and
          // reusing the previous zip's node would carry over its resolved
          // height while the new page loads.
          <div key={src} className="scroll-page" data-page={idx}>
            {failedPages.has(name) ? (
              <div className="page-placeholder page-failed">Failed to load page {idx + 1}</div>
            ) : (
              <img
                src={src}
                alt={`Page ${idx + 1}`}
                className="scroll-img"
                loading="lazy"
                decoding="async"
                // .scroll-img reserves a 2:3 box so pages below don't jump when
                // a lazy image arrives. Cleared imperatively rather than via
                // state — a re-render per load would touch all N page nodes.
                onLoad={(e) => {
                  e.currentTarget.style.aspectRatio = "auto";
                }}
                onError={() => onPageError(name)}
              />
            )}
          </div>
        );
      }),
    [images, srcFor, failedPages, onPageError],
  );

  if (error) {
    return (
      <div className="viewer viewer-empty viewer-error">
        <span className="error-title">Failed to open zip</span>
        <span className="error-detail">{error}</span>
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className="viewer viewer-empty">
        <span>Select a zip file to start reading</span>
      </div>
    );
  }

  if (viewMode === "scroll") {
    return (
      <div className="viewer viewer-scroll" ref={scrollRef}>
        {scrollPages}
      </div>
    );
  }

  // single / double — pre-render adjacent spreads so navigation doesn't wait on
  // a fetch+decode. Hidden spreads still load: the webview fetches them as soon
  // as the <img> is in the DOM.
  const doubleMode = viewMode === "double";
  const PRELOAD = 6;
  const spreads: number[] = [];

  // Backward: include every page in range so landscape-caused odd-index pages
  // are always covered. Stride depends on each page's orientation, so stride-2
  // skipping backwards would miss reachable pages.
  const maxBack = (doubleMode ? 2 : 1) * PRELOAD;
  for (let p = Math.max(0, currentPage - maxBack); p < currentPage; p++) spreads.push(p);

  spreads.push(currentPage);

  // Forward: orientation-aware stride, mirroring actual goNext navigation
  {
    let fp = currentPage;
    for (let i = 0; i < PRELOAD; i++) {
      fp += spreadStride(images, imgLandscape, fp, doubleMode);
      if (fp >= images.length) break;
      spreads.push(fp);
    }
  }

  return (
    <div className="viewer viewer-paged">
      {spreads.map((spreadPage) => {
        const isActive = spreadPage === currentPage;
        // Pair only when neither half is landscape — same rule App navigates by
        const paired = spreadStride(images, imgLandscape, spreadPage, doubleMode) === 2;
        const names = (
          paired ? [images[spreadPage + 1], images[spreadPage]] : [images[spreadPage]]
        ).filter(Boolean);

        return (
          <div
            key={spreadPage}
            className="pages-wrap"
            style={isActive ? undefined : { opacity: 0, pointerEvents: "none" }}
          >
            {names.map((name) => {
              const src = srcFor(name);
              // imgLandscape gains an entry exactly when the image finishes
              // loading, so it doubles as the "loaded" flag. Cheap here — a
              // paged view holds ~13 images in single mode, ~38 at most in
              // double (12 backward spreads + active + 6 forward, ×2 halves).
              const loaded = imgLandscape.has(name);
              return (
                <div key={src} className="page-slot">
                  {failedPages.has(name) ? (
                    <div className="page-placeholder page-failed">Failed to load</div>
                  ) : (
                    <>
                      {/* The placeholder sits beside the image, never in place
                          of it: a display:none <img> is never decoded, so
                          hiding the hidden-but-preloading spreads would defeat
                          the whole preload and flash on every page turn.
                          An unloaded <img> is 0×0, so it costs no layout.
                          No `decoding="async"` either — the point of preloading
                          is that revealing a spread needs no decode at all. */}
                      {!loaded && <div className="page-placeholder">Loading…</div>}
                      <img
                        src={src}
                        alt={name}
                        className="page-img"
                        // Backward spreads come first in DOM order, so after a
                        // jump the page being read would queue behind up to 12
                        // preloads. Order can't be changed (it keeps React from
                        // moving nodes on every turn) — priority can.
                        fetchPriority={isActive ? "high" : "auto"}
                        onLoad={(e) => {
                          const el = e.currentTarget;
                          onOrientationLoad(name, el.naturalWidth > el.naturalHeight);
                        }}
                        onError={() => onPageError(name)}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
