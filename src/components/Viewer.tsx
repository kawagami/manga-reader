import { useEffect, useRef } from "react";
import { ViewMode } from "../types";

interface ViewerProps {
  images: string[];
  currentPage: number;
  viewMode: ViewMode;
  loadedUrls: Map<string, string>;
  error?: string | null;
}

export function Viewer({ images, currentPage, viewMode, loadedUrls, error }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [images]);

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

  // single / double — double is right-to-left (manga order)
  const names =
    viewMode === "double"
      ? [images[currentPage + 1], images[currentPage]].filter(Boolean)
      : [images[currentPage]].filter(Boolean);

  return (
    <div className="viewer viewer-paged">
      <div className="pages-wrap">
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
    </div>
  );
}
