import { useCallback, useMemo, useState } from "react";
import { CSSProperties } from "react";
import { CellComponentProps, Grid } from "react-window";
import { FolderEntry, ZipFileEntry } from "../types";
import { thumbUrl } from "../utils/pageUrl";

const CARD_W = 150;
const GAP = 10;
const COL_W = CARD_W + GAP;
const ROW_H = 240;

type MyCellProps = {
  allZips: ZipFileEntry[];
  cols: number;
  selectedZip: string | null;
  onSelectZip: (path: string) => void;
};

function GalleryCard({ zip, isSelected, onSelect }: {
  zip: ZipFileEntry;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const src = thumbUrl(zip.path, zip.mtime);
  return (
    <div
      className={`gallery-card${isSelected ? " gallery-selected" : ""}`}
      onClick={onSelect}
    >
      {/* `loading="lazy"` is what replaces the old onCellsRendered fan-out: the
          webview requests covers as cells scroll in and evicts them on its own.
          `.gallery-cover` paints the placeholder colour until the image lands.
          Keyed by src so React builds a fresh node when the grid recycles this
          cell — otherwise the cover-failed class below would stick to whatever
          zip scrolls into the same slot next. */}
      <img
        key={src}
        className="gallery-cover"
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={(e) => e.currentTarget.classList.add("cover-failed")}
      />
      <span className="gallery-name">{zip.name}</span>
    </div>
  );
}

const CELL_STYLE: CSSProperties = { paddingRight: GAP, paddingBottom: GAP, boxSizing: "border-box" };

function GridCell({ ariaAttributes, columnIndex, rowIndex, style, allZips, cols, selectedZip, onSelectZip }: CellComponentProps<MyCellProps>) {
  const idx = rowIndex * cols + columnIndex;
  if (idx >= allZips.length) return <div style={style} />;
  const zip = allZips[idx];
  return (
    <div style={{ ...style, ...CELL_STYLE }} {...ariaAttributes}>
      <GalleryCard
        zip={zip}
        isSelected={selectedZip === zip.path}
        onSelect={() => onSelectZip(zip.path)}
      />
    </div>
  );
}

interface Props {
  folders: FolderEntry[];
  selectedZip: string | null;
  onSelectZip: (path: string) => void;
}

export function Gallery({ folders, selectedZip, onSelectZip }: Props) {
  const allZips = useMemo(() => folders.flatMap((f) => f.zip_files), [folders]);
  // null until the container mounts — rendering the grid with a guessed width
  // would flash a wrong column count on first paint. Callback ref measures
  // during commit (before paint); Grid's onResize handles later resizes.
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    // Grid fills the content box; clientWidth includes padding
    const cs = getComputedStyle(el);
    setContainerWidth(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  }, []);

  const cols = Math.max(1, Math.floor((containerWidth ?? COL_W) / COL_W));
  const rows = Math.ceil(allZips.length / cols);

  const handleResize = useCallback(({ width }: { width: number; height: number }) => {
    setContainerWidth(width);
  }, []);

  const cellProps: MyCellProps = useMemo(
    () => ({ allZips, cols, selectedZip, onSelectZip }),
    [allZips, cols, selectedZip, onSelectZip],
  );

  if (allZips.length === 0) {
    return (
      <div className="gallery gallery-empty">
        <span>No zips loaded. Open a directory first.</span>
      </div>
    );
  }

  return (
    <div className="gallery" ref={measureRef}>
      {containerWidth !== null && (
        <Grid
          columnCount={cols}
          rowCount={rows}
          columnWidth={COL_W}
          rowHeight={ROW_H}
          overscanCount={2}
          cellComponent={GridCell}
          cellProps={cellProps}
          onResize={handleResize}
          style={{ height: "100%", width: "100%" }}
        />
      )}
    </div>
  );
}
