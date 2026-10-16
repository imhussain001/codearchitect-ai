import JSZip from "jszip";
import type { SourceFile } from "@/lib/types";
import { isAnalyzableSource } from "@/lib/engines/heuristicGraph";

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 200 * 1024;

/**
 * Extract analyzable source files from a ZIP. GitHub archives wrap everything
 * in a single `<repo>-<sha>/` folder, which is stripped.
 */
export async function extractSourceFiles(data: ArrayBuffer | Uint8Array): Promise<{ files: SourceFile[]; skipped: number }> {
  if (data.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive is ${(data.byteLength / 1e6).toFixed(1)} MB; the limit is ${MAX_ARCHIVE_BYTES / 1e6} MB.`);
  }
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);

  const roots = new Set(entries.map((e) => e.name.split("/")[0]));
  const stripPrefix = roots.size === 1 && entries.every((e) => e.name.includes("/"));

  const files: SourceFile[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const path = stripPrefix ? entry.name.slice(entry.name.indexOf("/") + 1) : entry.name;
    if (path.includes("..") || !isAnalyzableSource(path)) continue;
    const content = await entry.async("string");
    if (content.length > MAX_SOURCE_FILE_BYTES) {
      skipped++;
      continue;
    }
    files.push({ path, content });
  }
  return { files, skipped };
}
