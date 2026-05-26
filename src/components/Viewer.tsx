import { useEffect, useRef } from "react";
import { ViewMode } from "../types";

interface ViewerProps {
  images: string[];
  currentPage: number;
  viewMode: ViewMode;
  loadedUrls: Map<string, string>;
  imgLandscape: Map<string, boolean>;
  onOrientationLoad: (name: string, isLandscape: boolean) => void;
  error?: string | null;
  zipKey?: string | null;
}

export function Viewer({ images, currentPage, viewMode, loadedUrls, imgLandscape, onOrientationLoad, error, zipKey }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [zipKey]);

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
        {images.map((name, idx) => {
          const url = loadedUrls.get(name);
          return (
            <div key={name} className="scroll-page">
              {url ? (
                <img
                  src={url}
                  alt={`Page ${idx + 1}`}
                  className="scroll-img"
                />
              ) : (
                <div className="page-placeholder">Loading {idx + 1}…</div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // single / double — pre-render adjacent spreads to avoid decode flicker on navigation
  // Always anchor at currentPage so odd-index pages (after landscape stride=1 nav) are never missing
  const stride = viewMode === "double" ? 2 : 1;
  const PRELOAD = 6;
  const spreads: number[] = [];
  for (let p = currentPage; p >= 0 && currentPage - p <= stride * PRELOAD; p -= stride) spreads.unshift(p);
  for (let p = currentPage + stride; p < images.length && p - currentPage <= stride * PRELOAD; p += stride) spreads.push(p);

  return (
    <div className="viewer viewer-paged">
      {spreads.map((spreadPage) => {
        const isActive = spreadPage === currentPage;

        // In double mode, collapse to single if the lead page is landscape
        const leadName = images[spreadPage];
        const leadIsLandscape = viewMode === "double" && imgLandscape.get(leadName) === true;
        const names =
          viewMode === "double" && !leadIsLandscape
            ? [images[spreadPage + 1], images[spreadPage]].filter(Boolean)
            : [images[spreadPage]].filter(Boolean);

        return (
          <div
            key={spreadPage}
            className="pages-wrap"
            style={isActive ? undefined : { opacity: 0, pointerEvents: "none" }}
          >
            {names.map((name) => {
              const url = loadedUrls.get(name);
              return (
                <div key={name} className="page-slot">
                  {url ? (
                    <img
                      src={url}
                      alt={name}
                      className="page-img"
                      onLoad={(e) => {
                        const el = e.currentTarget;
                        onOrientationLoad(name, el.naturalWidth > el.naturalHeight);
                      }}
                    />
                  ) : (
                    <div className="page-placeholder">Loading…</div>
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
