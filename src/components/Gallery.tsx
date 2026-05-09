import { useEffect } from "react";
import { FolderEntry, ZipFileEntry } from "../types";

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
    const CONCURRENT = 2;
    const paths = folders.flatMap((f) => f.zip_files.map((z) => z.path));
    let idx = 0;
    let cancelled = false;

    const runNext = () => {
      if (cancelled || idx >= paths.length) return;
      const path = paths[idx++];
      onLoadCover(path).finally(runNext);
    };

    // Seed CONCURRENT workers
    for (let i = 0; i < CONCURRENT; i++) runNext();

    return () => { cancelled = true; };
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
