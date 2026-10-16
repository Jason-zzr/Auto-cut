import { z } from "zod";
import { HostError } from "../sessions.ts";
import type { ProjectFiles } from "./files.ts";
import { emptyRoots, encodeId, objectReference, referenceKey, sha256, type Manifest, type Save } from "./records.ts";
import { writeObject } from "./objects.ts";

export const snapshotInput = z.strictObject({
  editorSnapshotId: z.string().min(1).max(256), editorSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  format: z.literal("timeline-studio-editor-snapshot"), payload: z.record(z.string(), z.json()),
  refs: z.array(objectReference).max(100_000),
});
export const snapshotRecord = snapshotInput.extend({ schemaVersion: z.literal(1), projectId: z.string().min(1).max(256) });
export type SnapshotInput = z.infer<typeof snapshotInput>;

const number = z.number().finite();
const nonnegative = number.nonnegative();
const identity = z.string().min(1);
const mediaRef = objectReference.refine(ref => ref.kind === "media" && Boolean(ref.blobId)).nullable();
const item = z.object({ id: identity, duration: nonnegative.optional(), start: number.optional(),
  sourceStart: nonnegative.optional(), sourceDuration: nonnegative.optional(), playbackRate: number.positive().optional() }).catchall(z.json());
const items = (schema: typeof item = item) => z.array(schema).refine(values => new Set(values.map(value => value.id)).size === values.length);
const editorPayload = z.strictObject({
  script: z.string(), commandState: z.strictObject({ schemaVersion: z.literal(1), revision: nonnegative.int(), appliedOperationIds: z.array(identity) }),
  selectedVoiceId: z.string(), speed: number.positive(), volume: nonnegative,
  captionSegments: z.array(item.extend({ text: z.string(), weight: nonnegative.optional(), hidden: z.boolean().optional() }))
    .refine(values => new Set(values.map(value => value.id)).size === values.length),
  captionPosition: z.string(), captionPlacement: z.strictObject({ x: number, y: number }), captionSize: number.positive(),
  captionStyle: z.record(z.string(), z.json()), captionStylePresetId: z.string(), captionStylePresets: items(), captionsEnabled: z.boolean(),
  visualSegments: items(), visualOverlaySegments: items(), imageName: z.string(), imageMeta: z.string(), imageRef: mediaRef,
  visualType: z.string(), imageDuration: nonnegative, imageClipCount: nonnegative.int(), fitMode: z.string(), ratioId: z.string(),
  selectedFilterId: z.string(), selectedTransitionId: z.string(), stickerSegments: items(), timelineMarkers: items(), selectedStickerId: z.string(),
  audioSegments: items(), audioRef: mediaRef, audioDuration: nonnegative, timelineHorizon: nonnegative,
  musicRef: mediaRef, musicSegments: items(), musicStart: number, musicName: z.string(), musicDuration: nonnegative, musicVolume: nonnegative,
  sourceAudioRef: mediaRef, sourceAudioName: z.string(), sourceAudioDuration: nonnegative, sourceAudioVolume: nonnegative, sourceAudioStart: number,
  sourceAudioAssetId: z.string(), sourceAudioLinked: z.boolean(), sourceAudioSpatialEffect: z.string(), sourceAudioSpatialAmount: number,
  sourceVoiceColorOriginal: z.object({ name: z.string(), duration: nonnegative }).catchall(z.json()).nullable().optional(),
  trackVisibility: z.record(z.string(), z.boolean()), trackLocks: z.record(z.string(), z.boolean()), userAssets: items(), timelineZoom: number.positive(),
  selectedTrack: z.string(), selectedSegmentId: z.string(), selectedVisualSegmentId: z.string(), selectedVisualOverlayId: z.string(),
  selectedStickerSegmentId: z.string(), selectedAudioSegmentId: z.string(), currentTime: nonnegative,
});

export function validateSnapshot(input: SnapshotInput, current: Manifest | null) {
  if (!editorPayload.safeParse(input.payload).success) throw new HostError("INVALID_ARGUMENT", 400, "Snapshot is missing complete editor state or contains invalid field types.");
  const objects = new Map((current?.objects ?? []).map(object => [referenceKey(object), object]));
  const refs = new Set<string>();
  for (const ref of input.refs) {
    const key = referenceKey(ref);
    if (refs.has(key) || !objects.has(key) || !["asset", "media", "resource"].includes(ref.kind)) {
      throw new HostError("REFERENCE_INVALID", 409, "Snapshot media must be registered before saving.");
    }
    refs.add(key);
  }
  // mediaRef is the durable media locator. Runtime URLs and Blob/cache fields never belong in a snapshot.
  const walk = (value: unknown, depth: number) => {
    if (depth > 64) throw new HostError("INVALID_ARGUMENT", 400, "Snapshot nesting exceeds its limit.");
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "mediaBindings") {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new HostError("REFERENCE_INVALID", 409, "Invalid media bindings.");
        for (const [field, binding] of Object.entries(item)) {
          const ref = objectReference.safeParse(binding);
          if (!["blob", "src", "url", "previewSrc", "originalBlob", "originalSrc", "thumbnail", "compatibilityAudioBlob", "voiceColorOriginalBlob", "voiceColorOriginalUrl"].includes(field) ||
              !ref.success || ref.data.kind !== "media" || !refs.has(referenceKey(ref.data))) {
            throw new HostError("REFERENCE_INVALID", 409, "Snapshot media binding is not registered.");
          }
        }
        continue;
      }
      if (["blob", "src", "url", "peaks", "trackFrames", "bearer", "bootstrapNonce"].includes(key)) {
        throw new HostError("INVALID_ARGUMENT", 400, "Snapshot contains transient media or session data.");
      }
      if (["mediaRef", "imageRef", "audioRef", "musicRef", "sourceAudioRef"].includes(key) && item !== null) {
        const ref = objectReference.safeParse(item);
        if (!ref.success || ref.data.kind !== "media" || !refs.has(referenceKey(ref.data))) throw new HostError("REFERENCE_INVALID", 409, "Snapshot media reference is missing from its declared resources.");
      } else walk(item, depth + 1);
    }
  };
  walk(input.payload, 0);
}

export function prepareSnapshot(files: ProjectFiles, projectId: string) {
  return async (current: Manifest | null, save: Save) => {
    const input = snapshotInput.parse(save.request);
    validateSnapshot(input, current);
    if (current?.editorSequence !== null && current?.editorSequence !== undefined && input.editorSequence <= current.editorSequence) {
      throw new HostError("OUT_OF_ORDER_SNAPSHOT", 409, "A newer editor snapshot is already committed.");
    }
    const value = snapshotRecord.parse({ ...input, schemaVersion: 1, projectId });
    const path = `data/editor-snapshots/${encodeId(input.editorSnapshotId)}.json`;
    const object = await writeObject(files, { kind: "editor-snapshot", entityId: input.editorSnapshotId }, path, value);
    const roots = structuredClone(current?.roots ?? emptyRoots());
    roots.editorSnapshots = [{ kind: "editor-snapshot", entityId: input.editorSnapshotId }];
    return { roots, objects: [...(current?.objects ?? []).filter(item => referenceKey(item) !== referenceKey(object)), object],
      editorSnapshotId: input.editorSnapshotId, editorSequence: input.editorSequence };
  };
}

export async function readSnapshot(files: ProjectFiles, current: Manifest | null) {
  if (!current?.editorSnapshotId) return null;
  const object = current.objects.find(item => item.kind === "editor-snapshot" && item.entityId === current.editorSnapshotId);
  if (!object) throw new HostError("PROJECT_INVALID", 409, "The saved editor snapshot is missing.");
  const bytes = await files.read(object.path);
  if (bytes.length !== object.sizeBytes || sha256(bytes) !== object.sha256) throw new HostError("PROJECT_INVALID", 409, "The saved editor snapshot is damaged.");
  const snapshot = snapshotRecord.parse(JSON.parse(bytes.toString("utf8")));
  if (snapshot.projectId !== current.projectId || snapshot.editorSnapshotId !== current.editorSnapshotId || snapshot.editorSequence !== current.editorSequence) {
    throw new HostError("PROJECT_INVALID", 409, "The editor snapshot identity differs from its save point.");
  }
  validateSnapshot(snapshot, current);
  return snapshot;
}
