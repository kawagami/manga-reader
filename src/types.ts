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
