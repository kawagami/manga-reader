import { useCallback, useMemo, useState } from "react";
import { CSSProperties } from "react";
import { CellComponentProps, Grid } from "react-window";
import { FolderEntry, ZipFileEntry } from "../types";

const CARD_W = 150;
const GAP = 10;
const COL_W = CARD_W + GAP;
const ROW_H = 240;

type MyCellProps = {
  allZips: ZipFileEntry[];
  cols: number;
  coverImages: Map<string, string>;
  selectedZip: string | null;
  onSelectZip: (path: string) => void;
};

function GalleryCard({ zip, coverUrl, isSelected, onSelect }: {
  zip: ZipFileEntry;
  coverUrl: string | undefined;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`gallery-card${isSelected ? " gallery-selected" : ""}`}
      onClick={onSelect}
    >
      {coverUrl ? (
        <img className="gallery-cover" src={coverUrl} alt="" />
      ) : (
        <div className="gallery-placeholder" />
      )}
      <span className="gallery-name">{zip.name}</span>
    </div>
  );
}

const CELL_STYLE: CSSProperties = { paddingRight: GAP, paddingBottom: GAP, boxSizing: "border-box" };

function GridCell({ ariaAttributes, columnIndex, rowIndex, style, allZips, cols, coverImages, selectedZip, onSelectZip }: CellComponentProps<MyCellProps>) {
  const idx = rowIndex * cols + columnIndex;
  if (idx >= allZips.length) return <div style={style} />;
  const zip = allZips[idx];
  return (
    <div style={{ ...style, ...CELL_STYLE }} {...ariaAttributes}>
      <GalleryCard
        zip={zip}
        coverUrl={coverImages.get(zip.path)}
        isSelected={selectedZip === zip.path}
        onSelect={() => onSelectZip(zip.path)}
      />
    </div>
  );
}

interface Props {
  folders: FolderEntry[];
  coverImages: Map<string, string>;
  selectedZip: string | null;
  onSelectZip: (path: string) => void;
  onLoadCover: (zipPath: string) => Promise<void>;
}

export function Gallery({ folders, coverImages, selectedZip, onSelectZip, onLoadCover }: Props) {
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

  const handleCellsRendered = useCallback((
    _visible: { columnStartIndex: number; columnStopIndex: number; rowStartIndex: number; rowStopIndex: number },
    all: { columnStartIndex: number; columnStopIndex: number; rowStartIndex: number; rowStopIndex: number },
  ) => {
    for (let r = all.rowStartIndex; r <= all.rowStopIndex; r++) {
      for (let c = all.columnStartIndex; c <= all.columnStopIndex; c++) {
        const idx = r * cols + c;
        if (idx < allZips.length) onLoadCover(allZips[idx].path);
      }
    }
  }, [cols, allZips, onLoadCover]);

  const cellProps: MyCellProps = useMemo(
    () => ({ allZips, cols, coverImages, selectedZip, onSelectZip }),
    [allZips, cols, coverImages, selectedZip, onSelectZip],
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
          onCellsRendered={handleCellsRendered}
          style={{ height: "100%", width: "100%" }}
        />
      )}
    </div>
  );
}
