export interface ZipFileEntry {
  name: string;
  path: string;
}

export interface FolderEntry {
  name: string;
  path: string;
  zip_files: ZipFileEntry[];
}

export interface ImagePayload {
  name: string;
  index: number;
  total: number;
  data: string;
  mime_type: string;
}

export type ViewMode = "single" | "double" | "scroll";
