export interface ZipFileEntry {
  name: string;
  path: string;
}

export interface FolderEntry {
  name: string;
  path: string;
  zip_files: ZipFileEntry[];
}

export type ViewMode = "single" | "double" | "scroll" | "gallery";
