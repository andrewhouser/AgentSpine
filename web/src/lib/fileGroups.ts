import type { SavedFile } from "./types.ts";

/** What the Files page calls files that came from no project (or from one since deleted). */
export const GENERAL = "General";

export interface FileGroup {
  files: SavedFile[];
  key: string;
  name: string;
  projectId: null | number;
}

/** Case-insensitive match on name, folder path or project name. An empty query keeps everything. */
export const filterFiles = (files: SavedFile[], query: string): SavedFile[] => {
  const q = query.trim().toLowerCase();
  if (!q) return files;
  return files.filter((f) => `${f.name}\n${f.path}\n${f.project_name ?? GENERAL}`.toLowerCase().includes(q));
};

/**
 * Folders for the Finder-style view: one per project, A to Z, then General last. Grouping is by
 * project id, not name, so two projects with the same name stay two folders. Inside a folder the
 * order the server sent (newest first) is kept. The Swift twin in FilesView.swift follows the same rules.
 */
export const groupFiles = (files: SavedFile[]): FileGroup[] => {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    const projectId = f.project_id != null && f.project_name ? f.project_id : null;
    const key = projectId == null ? "general" : `p${projectId}`;
    let g = groups.get(key);
    if (!g) {
      g = { files: [], key, name: projectId == null ? GENERAL : (f.project_name as string), projectId };
      groups.set(key, g);
    }
    g.files.push(f);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.projectId == null) return 1;
    if (b.projectId == null) return -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.projectId - b.projectId;
  });
};
