export interface ZipFileEntry {
  name: string;
  path: string;
  mtime: number; // cache-busting version for the cover URL
}

export interface FolderEntry {
  name: string;
  path: string;
  zip_files: ZipFileEntry[];
}

export type ViewMode = "single" | "double" | "scroll" | "gallery";

// find_duplicates report — see src-tauri/src/dupes.rs. Groups and pairs hold
// indices into `items`.
export interface DupeItem {
  path: string;
  name: string;
  folder: string;
  size: number;
  mtime: number;
  pages: number;
}

export interface OverlapPair {
  a: number; // the archive with more distinct pages (a_unique >= b_unique)
  b: number;
  shared: number;
  a_unique: number; // distinct pages — `pages` counts entries, incl. repeated images
  b_unique: number;
  subset: boolean; // every page of b is in a
}

export interface DupeReport {
  items: DupeItem[];
  identical: number[][];
  overlaps: OverlapPair[];
  broken: { item: number; error: string }[];
  no_images: number[];
  scanned: number;
  elapsed_ms: number;
}

export interface DupeProgress {
  done: number;
  total: number;
}
