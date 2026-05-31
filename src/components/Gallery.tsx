import { useCallback, useState } from "react";
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
  const allZips = folders.flatMap((f) => f.zip_files);
  const [containerWidth, setContainerWidth] = useState(800);

  const cols = Math.max(1, Math.floor(containerWidth / COL_W));
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

  const cellProps: MyCellProps = { allZips, cols, coverImages, selectedZip, onSelectZip };

  if (allZips.length === 0) {
    return (
      <div className="gallery gallery-empty">
        <span>No zips loaded. Open a directory first.</span>
      </div>
    );
  }

  return (
    <div className="gallery">
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
    </div>
  );
}
