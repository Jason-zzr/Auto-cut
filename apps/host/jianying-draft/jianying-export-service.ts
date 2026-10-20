import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { STICKER_LIBRARY } from "../../../src/config/editor.js";
import { HostError, type PageSession } from "../sessions.ts";
import type { Projects } from "../storage/projects.ts";
import { readSnapshot } from "../storage/snapshots.ts";
import { referenceKey } from "../storage/records.ts";
import { inspectMedia } from "../storage/media.ts";
import { mapTimeline, timelineMediaReferences } from "./timeline-mapper.ts";
import { writeDraft } from "./draft-writer.ts";
import { jianyingDraftRoot, validateDraftName } from "./jianying-paths.ts";
import type { ResolvedMedia } from "./draft-types.ts";

async function readPngSize(path: string) {
  const bytes = Buffer.alloc(24), file = await open(path, "r");
  try {
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } finally { await file.close(); }
}

export async function builtInStickerMedia(webRoot: string, payload: Record<string, unknown>) {
  const root = await realpath(webRoot), result = new Map<string, ResolvedMedia>();
  const catalog = new Map(STICKER_LIBRARY.map(item => [item.id, item]));
  const segments = Array.isArray(payload.stickerSegments) ? payload.stickerSegments : [];
  const ids = new Set(segments.map(item => item && typeof item === "object" && "stickerId" in item ? item.stickerId : null)
    .filter((value): value is string => typeof value === "string"));
  for (const stickerId of ids) {
    const source = catalog.get(stickerId)?.src;
    if (!source?.startsWith("/assets/stickers/") || source.includes("\\") || source.split("/").includes("..")) continue;
    try {
      const path = await realpath(join(root, source.slice(1))), within = relative(root, path), stat = await lstat(path);
      if (!within || within.split("/").includes("..") || isAbsolute(within) || !stat.isFile()) continue;
      const size = await readPngSize(path);
      if (size) result.set(stickerId, { path, kind: "image", durationSeconds: 0, mimeType: "image/png", ...size });
    } catch { /* Missing built-in assets are reported per sticker by the mapper. */ }
  }
  return result;
}

export async function exportJianyingDraft(projects: Projects, page: PageSession, projectId: string,
  input: { draftName: string; outputDir?: string }, webRoot: string) {
  const project = projects.get(page, projectId);
  const root = await jianyingDraftRoot(input.outputDir), name = validateDraftName(input.draftName);
  const withinProject = relative(project.files.directory, root);
  if (!withinProject || withinProject.split("/")[0] !== ".." && !isAbsolute(withinProject)) {
    throw new HostError("INVALID_ARGUMENT", 400, "Draft output must be outside the managed project.");
  }
  // Use the existing queue to keep this committed closure stable during probing/writing.
  // No pin or save is added: exported drafts reference project files and require them to remain available.
  return project.commits.maintain(async current => {
    const snapshot = await readSnapshot(project.files, current);
    if (!snapshot) throw new HostError("EDITOR_SNAPSHOT_NOT_FOUND", 409, "Save the editor timeline before exporting a Jianying draft.");
    const objects = new Map(current.objects.map(object => [referenceKey(object), object]));
    const media = new Map<string, ResolvedMedia>();
    const seen = new Set<string>();
    for (const ref of timelineMediaReferences(snapshot.payload)) {
      const key = referenceKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const object = objects.get(key);
      if (!object || object.kind !== "media") continue;
      try {
        const path = await realpath(join(project.files.directory, object.path));
        const local = relative(project.files.directory, path), stat = await lstat(path);
        if (!local || local.split("/").includes("..") || isAbsolute(local) || !stat.isFile() || stat.size !== object.sizeBytes) continue;
        const inspected = await inspectMedia(project.files, object.path, object.sizeBytes, true)
          .catch(() => inspectMedia(project.files, object.path, object.sizeBytes, false));
        media.set(key, { path, kind: inspected.kind, durationSeconds: inspected.durationSeconds, mimeType: inspected.mimeType });
      } catch { /* An unavailable input is reported per consuming clip by the mapper. */ }
    }
    const stickers = await builtInStickerMedia(webRoot, snapshot.payload);
    const model = mapTimeline(snapshot.payload, ref => ref ? media.get(referenceKey(ref)) : undefined, stickerId => stickers.get(stickerId));
    if (!model.tracks.some(track => track.segments.length > 0)) {
      throw new HostError("TIMELINE_EMPTY", 400, "The saved timeline has no exportable clips.");
    }
    model.report.mapped.push({ track: "project", segmentId: snapshot.editorSnapshotId, feature: "committedSnapshot",
      reason: `Exported committed sequence ${snapshot.editorSequence}; unsaved editor changes are excluded.` });
    model.report.skipped.push({ track: "project", segmentId: "", feature: "mediaCopy",
      reason: "Media is referenced in place. Moving the project or reclaiming its media breaks the exported draft." });
    if (stickers.size) model.report.skipped.push({ track: "project", segmentId: "", feature: "stickerAssetLifetime",
      reason: "Sticker image layers reference the current Auto-cut web distribution. Moving or replacing it breaks those layers." });
    return writeDraft(root, name, model);
  });
}
