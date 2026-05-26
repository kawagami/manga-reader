import { useEffect, useRef } from "react";
import { ViewMode } from "../types";

interface ViewerProps {
  images: string[];
  currentPage: number;
  viewMode: ViewMode;
  loadedUrls: Map<string, string>;
  error?: string | null;
  zipKey?: string | null;
}

export function Viewer({ images, currentPage, viewMode, loadedUrls, error, zipKey }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset scroll only when zip changes, not when images are appended mid-stream
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
                <img src={url} alt={`Page ${idx + 1}`} className="scroll-img" />
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
  const stride = viewMode === "double" ? 2 : 1;
  const PRELOAD = 2;
  const renderFrom = Math.max(0, currentPage - stride * PRELOAD);
  const renderTo = Math.min(images.length - 1, currentPage + stride * PRELOAD);
  const spreads: number[] = [];
  for (let p = renderFrom; p <= renderTo; p += stride) spreads.push(p);

  return (
    <div className="viewer viewer-paged">
      {spreads.map((spreadPage) => {
        const isActive = spreadPage === currentPage;
        const names =
          viewMode === "double"
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
                    <img src={url} alt={name} className="page-img" />
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
