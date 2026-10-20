import type { ObjectReference } from "../storage/records.ts";

export type Timerange = { start: number; duration: number };
export type ExportIssue = { track: string; segmentId: string; feature: string; reason: string };
export type ExportReport = { mapped: ExportIssue[]; skipped: ExportIssue[] };
export type ResolvedMedia = {
  path: string; kind: "video" | "image" | "audio"; durationSeconds: number | null;
  mimeType: string; width?: number; height?: number;
};
export type ClipSettings = {
  alpha: number; flip: { horizontal: boolean; vertical: boolean }; rotation: number;
  scale: { x: number; y: number }; transform: { x: number; y: number };
};
export type DraftClip = {
  target: Timerange; source: Timerange | null; speed: number; volume: number;
  media?: ResolvedMedia; name: string; width: number; height: number; clip: ClipSettings | null;
  text?: string; transition?: { id: string; duration: number };
};
export type DraftTrack = { name: string; type: "video" | "audio" | "text"; renderIndex: number; segments: DraftClip[] };
export type DraftModel = { width: number; height: number; fps: number; tracks: DraftTrack[]; report: ExportReport };
export type MediaResolver = (ref: ObjectReference | null) => ResolvedMedia | undefined;
export type StickerResolver = (stickerId: string) => ResolvedMedia | undefined;
