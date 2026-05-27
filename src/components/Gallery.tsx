import { useEffect } from "react";
import { FolderEntry, ZipFileEntry } from "../types";
import { concurrentForEach } from "../utils/concurrentForEach";

interface CardProps {
  zip: ZipFileEntry;
  coverUrl: string | undefined;
  isSelected: boolean;
  onSelect: () => void;
}

function GalleryCard({ zip, coverUrl, isSelected, onSelect }: CardProps) {
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

interface Props {
  folders: FolderEntry[];
  coverImages: Map<string, string>;
  selectedZip: string | null;
  onSelectZip: (path: string) => void;
  onLoadCover: (zipPath: string) => Promise<void>;
}

export function Gallery({ folders, coverImages, selectedZip, onSelectZip, onLoadCover }: Props) {
  const allZips = folders.flatMap((f) => f.zip_files);

  useEffect(() => {
    const paths = folders.flatMap((f) => f.zip_files.map((z) => z.path));
    const { cancel } = concurrentForEach(paths, 2, onLoadCover);
    return cancel;
  }, [folders]);

  if (allZips.length === 0) {
    return (
      <div className="gallery gallery-empty">
        <span>No zips loaded. Open a directory first.</span>
      </div>
    );
  }

  return (
    <div className="gallery">
      {allZips.map((zip) => (
        <GalleryCard
          key={zip.path}
          zip={zip}
          coverUrl={coverImages.get(zip.path)}
          isSelected={selectedZip === zip.path}
          onSelect={() => onSelectZip(zip.path)}
        />
      ))}
    </div>
  );
}
