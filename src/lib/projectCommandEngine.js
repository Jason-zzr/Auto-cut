import { MAX_TIMELINE_MARKER_SECONDS, TIMELINE_MARKER_COLORS, TIMELINE_MARKER_TYPES, normalizeTimelineMarkers } from "./timelineMarkers.js";
import { getCaptionTimeline, getTimedSegmentsEnd, createStickerSegment, getTimedSegmentLaneStateKey } from "./timeline.js";
import { CAPTION_FONT_CATALOG, resolveCaptionStyleForSegment } from "./captionFonts.js";
import { CAPTION_VISUAL_STYLE_KEYS, getCaptionStylePreset, applyCaptionPresetToStyle, buildCaptionPresetSnapshot, resolveCaptionSizeForSegment } from "./captionStyles.js";
import { AUDIO_SPATIAL_EFFECTS } from "./audioSpatialEffects.js";
import { normalizeVisualTransform, upsertVisualPropertyKeyframe, removeVisualPropertyKeyframe, updateVisualSegmentPlaybackRate } from "./visualEffects.js";
import { COLOR_GRADE_KEYFRAME_KEYS, normalizeColorGrade } from "./colorGrade.js";
import { FILTER_OPTIONS, STICKER_LIBRARY, DEFAULT_STICKER_SEGMENT_SECONDS, MIN_VISUAL_SEGMENT_SECONDS, MAX_TIMELINE_DURATION_SECONDS } from "../config/editor.js";
import { VISUAL_CLIP_ANIMATION_OPTIONS, normalizeVisualClipAnimation } from "./visualClipAnimations.js";
import { updateSubjectEffect } from "./subjectEffects.js";
import { updateClickRippleEffect } from "./clickRippleEffect.js";
import { normalizeCinematicDepth } from "./depthOfField.js";
import { normalizePhotoParallax } from "./photoParallax.js";
import { parseSrt, appendImportedCaptions, MAX_SRT_FILE_BYTES } from "./subtitles.js";
import { getLinkedSourceAudioSegments } from "./sourceAudioSync.js";
import { normalizeVectorDesign, buildVectorDesignPatch } from "./vectorDesign.js";
import { createEditableVectorDocument, updateVectorPart } from "./vectorDocument.js";
import { updateVisualSegmentSpeedCurve } from "./visualSpeedCurve.js";
import { validateMiganRegions } from "./miganRepairRegions.js";
import { resizeVisualSegmentState, splitCaptionSegmentState, splitAudioSegmentState, splitOverlaySegmentState, splitVisualSegmentState, trimVisualSegmentState } from "./timelineCutActions.js";
import { normalizeSmartFrame } from "./smartFrame.js";

export const PROJECT_COMMAND_SCHEMA_VERSION = 1;

const COMMAND_STATE_KEY = "commandState";
const MIN_TIMED_CAPTION_SECONDS = 0.2;

export const CAPTION_STYLE_PROPERTY_SCHEMA = Object.freeze({
  fontId: { type: "string", enum: CAPTION_FONT_CATALOG.map((font) => font.id) },
  captionSize: { type: "number", minimum: 12, maximum: 42 },
  ...Object.fromEntries(["textColor", "backgroundColor", "borderColor", "textStrokeColor"].map((key) => [key, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }])),
  ...Object.fromEntries(Object.entries({ backgroundOpacity: 1, shadowOpacity: 1, textStrokeWidth: 6, borderWidth: 8, radius: 28, paddingX: 52, paddingY: 32 })
    .map(([key, maximum]) => [key, { type: "number", minimum: 0, maximum }])),
  effect: { type: "string", enum: ["normal", "neon"] },
});

const TIMED_COLLECTIONS = Object.freeze({ audio: "audioSegments", music: "musicSegments", overlay: "visualOverlaySegments", overlays: "visualOverlaySegments", sticker: "stickerSegments", stickers: "stickerSegments" });

function invalidArgument(message) {
  throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}

function timedClip(project, operation) {
  const key = TIMED_COLLECTIONS[operation.track];
  if (!key) throw Object.assign(new Error(`Unsupported timed track: ${operation.track}`), { code: "UNSUPPORTED_TRACK" });
  return findById(project[key], operation.clipId, "Timed clip");
}

function shiftCaptionWords(words, delta, start, end) {
  return words.flatMap((word) => {
    if (!word || typeof word !== "object" || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) return [];
    const wordStart = Math.max(start, word.start + delta);
    const wordEnd = Math.min(end, word.end + delta);
    return wordEnd > wordStart ? [{ ...word, start: wordStart, end: wordEnd }] : [];
  });
}

function updateLinkedCaptionTiming(project, audioId, delta, end, lowerBound) {
  project.captionSegments = (project.captionSegments || []).map((caption) => {
    if (caption.audioSegmentId !== audioId) return caption;
    const shiftedStart = (Number(caption.start) || 0) + delta;
    const start = finiteNonNegative(lowerBound === undefined ? shiftedStart : Math.max(lowerBound, shiftedStart), "caption start");
    const captionEnd = Math.min(end ?? Infinity, finiteNonNegative(Math.max(0, (Number(caption.end) || 0) + delta), "caption end"));
    requireCaptionRange(start, captionEnd);
    return { ...caption, start, end: captionEnd,
      ...(Array.isArray(caption.words) ? { words: shiftCaptionWords(caption.words, delta, start, captionEnd) } : {}),
    };
  });
}

function failure(code, message, operationId = "") {
  return { ok: false, code, message, ...(operationId ? { operationId } : {}) };
}

function finiteNonNegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw Object.assign(new Error(`${name} must be a finite non-negative number`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function finitePositive(value, name) {
  const result = finiteNonNegative(value, name);
  if (result <= 0) throw Object.assign(new Error(`${name} must be greater than zero`), { code: "INVALID_ARGUMENT" });
  return result;
}

function requireCaptionRange(start, end) {
  finiteNonNegative(start, "caption start");
  finiteNonNegative(end, "caption end");
  const tolerance = Number.EPSILON * Math.max(1, start, end) * 4;
  if (end - start < MIN_TIMED_CAPTION_SECONDS - tolerance) {
    throw Object.assign(new Error("Captions must last at least 0.2 seconds"), { code: "INVALID_RANGE" });
  }
}

function resolveProjectCaptions(project) {
  const captions = Array.isArray(project?.captionSegments) ? project.captionSegments : [];
  const timeline = getCaptionTimeline(captions, getTimedSegmentsEnd(project?.audioSegments || []));
  return captions.map((caption, index) => ({ ...caption, start: timeline[index].start, end: timeline[index].end }));
}

// Caption timing can be implicit in a saved project. Match the editor's
// voice-track clock before editing so inserting an explicit caption or adding
// voice media cannot rescale the existing subtitles behind the review. Imported
// SRT cues may be shorter than the minimum used when creating or resizing cues.
export function materializeProjectCaptionTimings(project) {
  const captions = resolveProjectCaptions(project);
  for (const caption of captions) {
    finiteNonNegative(caption.start, "caption start");
    finiteNonNegative(caption.end, "caption end");
    if (caption.end <= caption.start) invalidArgument("Caption end must follow its start");
  }
  return { ...project, captionSegments: captions };
}

function findById(items, id, kind) {
  const item = (Array.isArray(items) ? items : []).find((entry) => entry.id === id);
  if (!item) throw Object.assign(new Error(`${kind} not found: ${id}`), { code: "CLIP_NOT_FOUND" });
  return item;
}

function commandState(project) {
  const value = project?.[COMMAND_STATE_KEY];
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
    appliedOperationIds: Array.isArray(value?.appliedOperationIds) ? [...new Set(value.appliedOperationIds)] : [],
  };
}

function moveTimed(project, operation) {
  if (operation.track === "audio") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const segment = timedClip(project, operation);
  const nextStart = finiteNonNegative(operation.start, "start");
  const previousStart = Number(segment.start) || 0;
  segment.start = nextStart;
  const delta = nextStart - previousStart;
  if (operation.layer !== undefined) {
    if (!["audio", "overlay", "overlays"].includes(operation.track) || !Number.isInteger(operation.layer) || operation.layer < 1 || operation.layer > 1000) invalidArgument("layer must identify an audio lane or overlay layer from 1 to 1000");
    segment[operation.track === "audio" ? "lane" : "layer"] = operation.track === "audio" ? operation.layer - 1 : operation.layer;
  }
  if (operation.track === "audio") {
    updateLinkedCaptionTiming(project, segment.id, delta);
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  }
}

function resizeTimed(project, operation) {
  if (operation.track === "audio") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const segment = timedClip(project, operation);
  const previousStart = Number(segment.start) || 0;
  const start = Object.hasOwn(operation, "start") ? finiteNonNegative(operation.start, "start") : previousStart;
  const duration = finitePositive(operation.duration, "duration");
  const sourceBacked = ["audio", "music"].includes(operation.track) || segment.type === "video";
  let resizedVisual = null;
  if (sourceBacked) {
    const visualOverlay = ["overlay", "overlays"].includes(operation.track) && segment.type === "video";
    if (segment.reversed || segment.reverse || segment.speedCurve?.enabled && !visualOverlay) throw Object.assign(new Error("Complex source timing cannot be resized"), { code: "UNSUPPORTED_TIMING" });
    if (segment.speedCurve?.enabled) resizedVisual = resizeVisualSegmentState(segment, duration);
    else {
      const rate = visualPlaybackRate(segment);
      const retainedSourceDuration = Number(segment.sourceDuration) || Number(segment.duration) * rate;
      if (duration * rate > retainedSourceDuration + 0.000001) throw Object.assign(new Error("Resize exceeds the retained source range"), { code: "SOURCE_RANGE_EXCEEDED" });
      segment.sourceDuration = duration * rate;
    }
  }
  if (resizedVisual) Object.assign(segment, resizedVisual);
  segment.start = start;
  segment.duration = duration;
  if (Number.isFinite(segment.fadeIn)) segment.fadeIn = Math.min(segment.fadeIn, duration);
  if (Number.isFinite(segment.fadeOut)) segment.fadeOut = Math.min(segment.fadeOut, duration);
  if (!resizedVisual && Array.isArray(segment.keyframes)) segment.keyframes = remapKeyframes(segment.keyframes, 0, duration);
  if (!resizedVisual && segment.propertyKeyframes) segment.propertyKeyframes = Object.fromEntries(Object.entries(segment.propertyKeyframes).map(([key, frames]) => [key, remapKeyframes(frames, 0, duration)]));
  if (operation.track === "audio") {
    const delta = start - previousStart;
    updateLinkedCaptionTiming(project, segment.id, delta, start + duration);
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  }
}

function visualPlaybackRate(segment) {
  const value = Number(segment?.playbackRate) || 1;
  return Math.max(0.25, Math.min(4, value));
}

function remapKeyframes(keyframes, start, end) {
  return (Array.isArray(keyframes) ? keyframes : [])
    .filter((frame) => Number(frame?.time) >= start && Number(frame?.time) <= end)
    .map((frame) => ({ ...frame, time: Number(frame.time) - start }));
}

// Older projects identify source audio by asset ID. Resolve that implicit
// relationship before changing the sequence, so deleting the last explicitly
// mapped piece can never attach previously unmapped sibling clips.
function materializeSourceAudioMappings(project) {
  const visuals = project.visualSegments || [];
  const hasMapped = visuals.some((clip) => clip.type === "video" && Number.isFinite(clip.sourceAudioOffset));
  const candidates = [...new Set(visuals.filter((clip) => clip.type === "video" && clip.assetId).map((clip) => clip.assetId))];
  const legacyAssetId = project.sourceAudioAssetId || (candidates.length === 1 ? candidates[0] : "");
  if (!hasMapped && !(legacyAssetId && Number(project.sourceAudioDuration) > 0)) return;
  project.visualSegments = visuals.map((clip) => {
    if (clip.type !== "video" || clip.sourceAudioUnmapped || Number.isFinite(clip.sourceAudioOffset)) return clip;
    return !hasMapped && clip.assetId === legacyAssetId
      ? { ...clip, sourceAudioOffset: 0 }
      : { ...clip, sourceAudioUnmapped: true };
  });
}

function trimVisual(project, operation) {
  materializeSourceAudioMappings(project);
  const segment = findById(project.visualSegments, operation.clipId, "Visual clip");
  if (segment.type !== "video") throw Object.assign(new Error("visual.trim currently supports video clips only"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  Object.assign(segment, trimVisualSegmentState(segment, operation.sourceIn, operation.sourceOut));
}

function trimSourceRange(segment, operation) {
  const sourceIn = finiteNonNegative(operation.sourceIn, "sourceIn");
  const sourceOut = finiteNonNegative(operation.sourceOut, "sourceOut");
  if (sourceOut <= sourceIn) throw Object.assign(new Error("sourceOut must be after sourceIn"), { code: "INVALID_RANGE" });
  const previousSourceIn = Math.max(0, Number(segment.sourceStart) || 0);
  const previousSourceDuration = Math.max(0, Number(segment.sourceDuration) || (Number(segment.duration) || 0) * visualPlaybackRate(segment));
  const previousSourceOut = previousSourceIn + previousSourceDuration;
  if (sourceIn < previousSourceIn || sourceOut > previousSourceOut) {
    throw Object.assign(new Error(`Trim range must stay within ${previousSourceIn}-${previousSourceOut}`), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const rate = visualPlaybackRate(segment);
  const removedLocalTime = (sourceIn - previousSourceIn) / rate;
  const duration = (sourceOut - sourceIn) / rate;
  segment.sourceStart = sourceIn;
  segment.sourceDuration = sourceOut - sourceIn;
  segment.duration = duration;
  if (Array.isArray(segment.keyframes)) segment.keyframes = remapKeyframes(segment.keyframes, removedLocalTime, removedLocalTime + duration);
  if (segment.propertyKeyframes) segment.propertyKeyframes = Object.fromEntries(Object.entries(segment.propertyKeyframes)
    .map(([key, frames]) => [key, remapKeyframes(frames, removedLocalTime, removedLocalTime + duration)]));
  if (Number.isFinite(segment.fadeIn)) segment.fadeIn = Math.min(segment.fadeIn, duration);
  if (Number.isFinite(segment.fadeOut)) segment.fadeOut = Math.min(segment.fadeOut, duration);
  return { removedLocalTime, duration };
}

function trimTimed(project, operation) {
  if (operation.track === "audio") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const segment = timedClip(project, operation);
  if (!["audio", "music", "overlay", "overlays"].includes(operation.track)
    || !["audio", "music"].includes(operation.track) && segment.type !== "video") {
    throw Object.assign(new Error("Source trimming requires audio or video media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const visualOverlay = ["overlay", "overlays"].includes(operation.track);
  if (segment.reversed || segment.reverse || segment.speedCurve?.enabled && !visualOverlay) {
    throw Object.assign(new Error("Complex source timing cannot be trimmed"), { code: "UNSUPPORTED_TIMING" });
  }
  const previousDuration = Number(segment.duration) || 0;
  const trimmed = visualOverlay && segment.speedCurve?.enabled
    ? trimVisualSegmentState(segment, operation.sourceIn, operation.sourceOut)
    : null;
  const result = trimmed ? { removedLocalTime: previousDuration - trimmed.duration, duration: trimmed.duration } : trimSourceRange(segment, operation);
  if (trimmed) Object.assign(segment, trimmed);
  const { removedLocalTime, duration } = result;
  if (operation.track === "audio") {
    const start = Number(segment.start) || 0;
    updateLinkedCaptionTiming(project, segment.id, -removedLocalTime, start + duration, start);
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  }
}

function duplicateTimed(project, operation) {
  if (!["audio", "music", "overlays", "stickers"].includes(operation.track)) invalidArgument("Audio, music, overlays or stickers track required");
  const source = timedClip(project, operation);
  const id = requireNewClipId(project, operation.newClipId);
  const offset = ["audio", "overlays"].includes(operation.track) ? 0.2 : source.duration + 0.2;
  const start = operation.start === undefined
    ? Math.max(0, Math.min(MAX_TIMELINE_DURATION_SECONDS - source.duration, (source.start || 0) + offset))
    : finiteNonNegative(operation.start, "start");
  if (start + source.duration > MAX_TIMELINE_DURATION_SECONDS) invalidArgument("Duplicate exceeds timeline duration limit");
  const key = TIMED_COLLECTIONS[operation.track];
  const copy = { ...structuredClone(source), id, start, archiveMediaId: source.archiveMediaId || source.id };
  if (operation.track === "overlays") {
    copy.layer = project[key].length + 1;
    copy.name = `${source.name || "画中画"} 副本`;
  }
  project[key].push(copy);
  if (operation.track === "audio") {
    const captions = (project.captionSegments || []).filter(item => item.audioSegmentId === source.id);
    const ids = operation.captionCopies || [];
    if (!Array.isArray(ids) || ids.length !== captions.length || new Set(ids.map(item => item.clipId)).size !== captions.length) invalidArgument("Provide exactly one captionCopies entry per linked caption");
    const copies = captions.map(caption => {
      const target = ids.find(item => item.clipId === caption.id);
      if (!target) invalidArgument("Missing linked caption copy ID");
      const captionId = requireNewClipId(project, target.newClipId);
      const delta = start - source.start;
      return { ...structuredClone(caption), id: captionId, audioSegmentId: id, start: caption.start + delta, end: caption.end + delta };
    });
    if (new Set(copies.map(item => item.id)).size !== copies.length) invalidArgument("Duplicate linked caption copy ID");
    project.captionSegments = [...(project.captionSegments || []), ...copies].sort((a, b) => (a.start || 0) - (b.start || 0));
    if (copies.length) project.script = project.captionSegments.map(caption => caption.text).join("\n");
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  } else if (operation.captionCopies?.length) invalidArgument("captionCopies requires an audio track");
  if (operation.track === "music") project.musicStart = Math.min(...project.musicSegments.map(item => item.start));
}

function splitTimed(project, operation) {
  if (!["audio", "music", "overlays", "stickers"].includes(operation.track)) invalidArgument("Audio, music, overlays or stickers track required");
  const source = timedClip(project, operation);
  const rightId = requireNewClipId(project, operation.rightClipId);
  const at = finiteNonNegative(operation.at, "at");
  if (operation.track === "stickers") {
    if (at <= source.start + 0.35 || at >= source.start + source.duration - 0.35) invalidArgument("Cut must leave more than 0.35 seconds on each side");
    const left = { ...source, duration: at - source.start };
    const right = { ...source, id: rightId, start: at, duration: source.start + source.duration - at };
    project.stickerSegments.splice(project.stickerSegments.findIndex(item => item.id === source.id), 1, left, right);
    return;
  }
  if (source.reversed || source.reverse) invalidArgument("Unsupported source timing");
  const overlay = operation.track === "overlays";
  if (overlay && Object.values(source.propertyKeyframes || {}).some(frames => frames?.length)) invalidArgument("Unsupported property keyframes");
  if (overlay) {
    if (at - source.start < MIN_VISUAL_SEGMENT_SECONDS || source.start + source.duration - at < MIN_VISUAL_SEGMENT_SECONDS) invalidArgument("Cut is too close to the overlay edge");
  } else if (at <= source.start + 0.05 || at >= source.start + source.duration - 0.05) invalidArgument("Cut must leave more than 0.05 seconds on each side");
  const [left, right] = overlay ? splitOverlaySegmentState(source, at) : splitAudioSegmentState(source, at);
  right.id = rightId;
  const key = TIMED_COLLECTIONS[operation.track];
  project[key].splice(project[key].findIndex(item => item.id === source.id), 1, left, right);
  if (operation.track === "audio") {
    project.captionSegments = (project.captionSegments || []).map(caption => {
      if (caption.audioSegmentId !== source.id || caption.end <= at) return caption;
      if (caption.start < at) invalidArgument("Split the crossing caption before splitting its audio");
      return { ...caption, audioSegmentId: rightId };
    });
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  }
}

function splitVisual(project, operation) {
  materializeSourceAudioMappings(project);
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const index = visuals.findIndex((segment) => segment.id === operation.clipId);
  if (index < 0) throw Object.assign(new Error(`Visual clip not found: ${operation.clipId}`), { code: "CLIP_NOT_FOUND" });
  const segment = visuals[index];
  const at = finitePositive(operation.at, "at");
  const duration = finitePositive(Number(segment.duration), "clip duration");
  if (at >= duration) throw Object.assign(new Error("at must be inside the visual clip"), { code: "INVALID_RANGE" });
  const rightClipId = typeof operation.rightClipId === "string" ? operation.rightClipId.trim() : "";
  if (!rightClipId) throw Object.assign(new Error("rightClipId is required"), { code: "INVALID_ARGUMENT" });
  requireNewClipId(project, rightClipId);
  const archiveMediaId = segment.archiveMediaId || segment.id;
  if (segment.reversed || segment.reverse || Object.values(segment.propertyKeyframes || {}).some(frames => frames?.length)) {
    throw Object.assign(new Error("Unsupported visual source timing"), { code: "UNSUPPORTED_TIMING" });
  }
  const [left, right] = splitVisualSegmentState(segment, at, duration - at);
  Object.assign(left, { id: segment.id, archiveMediaId });
  Object.assign(right, { id: rightClipId, archiveMediaId });
  project.visualSegments = [...visuals.slice(0, index), left, right, ...visuals.slice(index + 1)];
}

function reorderVisual(project, operation) {
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const from = visuals.findIndex((segment) => segment.id === operation.clipId);
  if (from < 0) throw Object.assign(new Error(`Visual clip not found: ${operation.clipId}`), { code: "CLIP_NOT_FOUND" });
  if (!Number.isInteger(operation.toIndex) || operation.toIndex < 0 || operation.toIndex >= visuals.length) {
    throw Object.assign(new Error("toIndex must identify an existing visual position"), { code: "INVALID_ARGUMENT" });
  }
  if (from === operation.toIndex) return;
  const next = [...visuals];
  const [moved] = next.splice(from, 1);
  next.splice(operation.toIndex, 0, moved);
  project.visualSegments = next;
}

function requireNewClipId(project, clipId) {
  const id = typeof clipId === "string" ? clipId.trim() : "";
  if (!id) throw Object.assign(new Error("clipId is required"), { code: "INVALID_ARGUMENT" });
  const exists = Object.values(TRACK_COLLECTIONS).some((key) => (project?.[key] || []).some((clip) => clip.id === id));
  if (exists) throw Object.assign(new Error(`Clip already exists: ${id}`), { code: "CLIP_ALREADY_EXISTS" });
  return id;
}

function findVisualSource(project, sourceClipId) {
  const source = [...(project.visualSegments || []), ...(project.visualOverlaySegments || [])].find((clip) => clip.id === sourceClipId);
  if (!source) throw Object.assign(new Error(`Visual source clip not found: ${sourceClipId}`), { code: "CLIP_NOT_FOUND" });
  return source;
}

function cloneVisualForSequence(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  const source = findVisualSource(project, operation.sourceClipId);
  const maximumDuration = finitePositive(Number(source.duration), "source clip duration");
  const duration = Object.hasOwn(operation, "duration") ? finitePositive(operation.duration, "duration") : maximumDuration;
  if (source.type === "video" && duration > maximumDuration) {
    throw Object.assign(new Error(`Video duration cannot exceed source clip duration ${maximumDuration}`), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const next = { ...source, id, archiveMediaId: source.archiveMediaId || source.id, duration };
  delete next.start;
  delete next.layer;
  delete next.baseTransform;
  delete next.transition;
  if (source.type === "video") next.sourceDuration = duration * visualPlaybackRate(source);
  if (Array.isArray(source.keyframes)) next.keyframes = remapKeyframes(source.keyframes, 0, duration);
  return next;
}

function appendVisual(project, operation) {
  materializeSourceAudioMappings(project);
  project.visualSegments = [...(project.visualSegments || []), cloneVisualForSequence(project, operation)];
}

function importAsset(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  if (!["visuals", "audio", "music"].includes(operation.track)) throw Object.assign(new Error("asset.import supports Visuals, Voiceover, or Music"), { code: "UNSUPPORTED_TRACK" });
  if (!operation.prepared || !["image", "video", "audio"].includes(operation.mediaType) || !operation.sha256 || !operation.archivePath) {
    throw Object.assign(new Error("asset.import must be prepared by an archive media service"), { code: "ASSET_NOT_PREPARED" });
  }
  const duration = finitePositive(operation.duration, "duration");
  const integrity = { sha256: operation.sha256, size: operation.size, mimeType: operation.mimeType, archivePath: operation.archivePath };
  if (operation.track === "audio" || operation.track === "music") {
    if (operation.mediaType !== "audio") throw Object.assign(new Error(`${operation.track} import requires audio media`), { code: "UNSUPPORTED_MEDIA_TYPE" });
    const start = Object.hasOwn(operation, "start") ? finiteNonNegative(operation.start, "start") : 0;
    const segment = { id, name: operation.name || id, start, duration, sourceStart: 0, sourceDuration: duration, playbackRate: 1, volume: operation.volume ?? (operation.track === "music" ? 0.35 : 1), fadeIn: 0, fadeOut: 0, muted: operation.muted === true, integrity };
    if (operation.track === "audio") {
      project.audioSegments = operation.replace === true ? [segment] : [...(project.audioSegments || []), segment];
      project.audioDuration = project.audioSegments.reduce((end, item) => Math.max(end, (Number(item.start) || 0) + (Number(item.duration) || 0)), 0);
    } else {
      project.musicSegments = [segment];
      project.musicName = segment.name;
      project.musicDuration = duration;
      project.musicStart = start;
      project.musicVolume = segment.volume;
    }
    return;
  }
  if (!["image", "video"].includes(operation.mediaType)) throw Object.assign(new Error("Visuals import requires image or video media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  materializeSourceAudioMappings(project);
  const segment = {
    id,
    assetId: operation.assetId || `asset-${operation.sha256.slice(0, 16)}`,
    archiveMediaId: id,
    name: operation.name || id,
    type: operation.mediaType,
    duration,
    width: Math.max(0, Number(operation.width) || 0),
    height: Math.max(0, Number(operation.height) || 0),
    sourceStart: 0,
    sourceDuration: operation.mediaType === "video" ? duration : 0,
    playbackRate: 1,
    muted: operation.muted === true,
    ...(operation.mediaType === "video" ? { sourceAudioUnmapped: true, sourceAudioDisabled: operation.muted === true } : {}),
    integrity,
  };
  project.visualSegments = [...(project.visualSegments || []), segment];
}

function insertVisual(project, operation) {
  materializeSourceAudioMappings(project);
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  if (!Number.isInteger(operation.atIndex) || operation.atIndex < 0 || operation.atIndex > visuals.length) {
    throw Object.assign(new Error("atIndex must be a valid visual insertion position"), { code: "INVALID_ARGUMENT" });
  }
  const next = cloneVisualForSequence(project, operation);
  project.visualSegments = [...visuals.slice(0, operation.atIndex), next, ...visuals.slice(operation.atIndex)];
}

function deleteVisual(project, operation) {
  materializeSourceAudioMappings(project);
  findById(project.visualSegments, operation.clipId, "Visual clip");
  project.visualSegments = project.visualSegments.filter((clip) => clip.id !== operation.clipId);
}

function duplicateVisual(project, operation) {
  materializeSourceAudioMappings(project);
  const source = findById(project.visualSegments, operation.clipId, "Visual clip");
  const id = requireNewClipId(project, operation.newClipId);
  const sourceIndex = project.visualSegments.indexOf(source);
  const atIndex = operation.atIndex === undefined ? sourceIndex + 1 : operation.atIndex;
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > project.visualSegments.length) {
    throw Object.assign(new Error("atIndex must be a valid visual insertion position"), { code: "INVALID_ARGUMENT" });
  }
  const copy = { ...structuredClone(source), id, archiveMediaId: source.archiveMediaId || source.id };
  // A transition belongs to a boundary, not to the duplicated media clip.
  delete copy.transition;
  project.visualSegments.splice(atIndex, 0, copy);
}

// The host prepares local asset metadata. Browser callers cannot supply this
// payload: the browser planner resolves an asset ID and constructs it itself.
function insertPreparedAsset(project, operation) {
  if (operation.track === "visuals") materializeSourceAudioMappings(project);
  const id = requireNewClipId(project, operation.clipId);
  const source = operation.preparedSource;
  if (operation.prepared !== true || !source || !["image", "video", "audio"].includes(source.type)) {
    throw Object.assign(new Error("asset.insert requires host-prepared media metadata"), { code: "ASSET_NOT_PREPARED" });
  }
  const duration = finitePositive(operation.duration, "duration");
  const segment = { ...structuredClone(source), id, duration };
  if (source.type !== "image") {
    const available = finitePositive(source.sourceDuration, "sourceDuration");
    if (duration > available) throw Object.assign(new Error("Asset duration exceeds its source"), { code: "SOURCE_RANGE_EXCEEDED" });
    segment.sourceDuration = duration;
  }
  if (operation.track === "visuals") {
    if (!["image", "video"].includes(source.type)) throw Object.assign(new Error("Visuals require image or video media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
    if (!Number.isInteger(operation.atIndex) || operation.atIndex < 0 || operation.atIndex > (project.visualSegments || []).length) {
      throw Object.assign(new Error("atIndex must be a valid visual insertion position"), { code: "INVALID_ARGUMENT" });
    }
    delete segment.start;
    project.visualSegments.splice(operation.atIndex, 0, segment);
  } else if (operation.track === "overlays") {
    if (!["image", "video"].includes(source.type)) throw Object.assign(new Error("Overlays require image or video media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
    segment.start = finiteNonNegative(operation.start, "start");
    segment.layer = operation.layer;
    segment.baseTransform = { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1, ...operation.transform };
    project.visualOverlaySegments = [...(project.visualOverlaySegments || []), segment];
  } else if (["audio", "music"].includes(operation.track)) {
    if (source.type !== "audio") throw Object.assign(new Error("Audio tracks require audio media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
    segment.start = finiteNonNegative(operation.start, "start");
    if (operation.lane !== undefined) segment.lane = operation.lane;
    const key = operation.track === "audio" ? "audioSegments" : "musicSegments";
    project[key] = [...(project[key] || []), segment];
    if (operation.track === "audio") project.audioDuration = project.audioSegments.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
    else {
      project.musicName = source.name;
      project.musicDuration = source.sourceDuration;
      project.musicStart = Math.min(...project.musicSegments.map((clip) => clip.start));
    }
  } else throw Object.assign(new Error("Unknown asset track"), { code: "UNSUPPORTED_TRACK" });
}

function addOverlay(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  const source = findVisualSource(project, operation.sourceClipId);
  const start = finiteNonNegative(operation.start, "start");
  const sourceDuration = finitePositive(Number(source.duration), "source clip duration");
  const duration = Object.hasOwn(operation, "duration") ? finitePositive(operation.duration, "duration") : Math.min(5, sourceDuration);
  if (source.type === "video" && duration > sourceDuration) {
    throw Object.assign(new Error(`Overlay duration cannot exceed source clip duration ${sourceDuration}`), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const layer = Object.hasOwn(operation, "layer") ? finitePositive(operation.layer, "layer")
    : (project.visualOverlaySegments || []).reduce((maximum, clip) => Math.max(maximum, Number(clip.layer) || 1), 0) + 1;
  const transform = operation.transform || {};
  for (const key of ["x", "y", "scale", "rotation", "opacity"]) {
    if (Object.hasOwn(transform, key) && (typeof transform[key] !== "number" || !Number.isFinite(transform[key]))) {
      throw Object.assign(new Error(`transform.${key} must be finite`), { code: "INVALID_ARGUMENT" });
    }
  }
  const rate = visualPlaybackRate(source);
  const overlay = {
    id,
    assetId: source.assetId || "",
    archiveMediaId: source.archiveMediaId || source.id,
    name: source.name || "Overlay",
    type: source.type === "video" ? "video" : "image",
    width: Number(source.width) || 0,
    height: Number(source.height) || 0,
    sourceStart: Math.max(0, Number(source.sourceStart) || 0),
    sourceDuration: source.type === "video" ? duration * rate : Math.max(0, Number(source.sourceDuration) || 0),
    playbackRate: rate,
    start,
    duration,
    muted: operation.muted === true,
    layer,
    baseTransform: { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1, ...transform },
    keyframes: [],
  };
  project.visualOverlaySegments = [...(project.visualOverlaySegments || []), overlay];
}

function setTransition(project, operation) {
  const transitions = new Set(["none", "fade", "zoom", "flash", "wipe-left", "wipe-up", "blur", "split", "glitch"]);
  if (!transitions.has(operation.transitionId)) throw Object.assign(new Error(`Unknown transition: ${operation.transitionId}`), { code: "INVALID_TRANSITION" });
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const index = visuals.findIndex((clip) => clip.id === operation.clipId);
  if (index < 0) throw Object.assign(new Error(`Visual clip not found: ${operation.clipId}`), { code: "CLIP_NOT_FOUND" });
  if (operation.transitionId !== "none" && index >= visuals.length - 1) {
    throw Object.assign(new Error("A transition requires a following visual clip"), { code: "INVALID_TRANSITION_TARGET" });
  }
  const maximum = index < visuals.length - 1
    ? Math.max(0.1, Math.min(2, Number(visuals[index].duration) / 2, Number(visuals[index + 1].duration) / 2))
    : 0.5;
  const duration = Object.hasOwn(operation, "duration") ? finitePositive(operation.duration, "duration") : 0.5;
  if (duration > maximum) throw Object.assign(new Error(`Transition duration cannot exceed ${maximum}`), { code: "INVALID_RANGE" });
  visuals[index].transition = { id: operation.transitionId, duration: Math.min(duration, maximum) };
}

function importSrtCaptions(project, operation) {
  if (typeof operation.text !== "string" || new TextEncoder().encode(operation.text).length > MAX_SRT_FILE_BYTES
    || !["append", "replace"].includes(operation.mode)) invalidArgument("Invalid SRT content or import mode");
  const parsed = parseSrt(operation.text);
  if (!parsed.captions.length) invalidArgument("SRT contains no valid captions");
  const imported = parsed.captions.map((caption, index) => ({ ...caption, id: `srt-${operation.id}-${index}` }));
  for (const caption of imported) requireNewClipId(project, caption.id);
  project.captionSegments = operation.mode === "append"
    ? appendImportedCaptions(materializeProjectCaptionTimings(project).captionSegments, imported) : imported;
  project.script = project.captionSegments.map(caption => caption.text).join("\n");
  project.captionsEnabled = true;
  project.trackVisibility = { ...project.trackVisibility, caption: true };
  return { warnings: [{ code: "srtImportPreview", count: imported.length, skipped: parsed.skipped }] };
}

function setCaptionsEnabled(project, operation) {
  if (typeof operation.enabled !== "boolean") invalidArgument("enabled must be a boolean");
  project.captionsEnabled = operation.enabled;
}

function updateCaption(project, operation) {
  project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  if (Object.hasOwn(operation, "text")) {
    if (typeof operation.text !== "string") throw Object.assign(new Error("text must be a string"), { code: "INVALID_ARGUMENT" });
    caption.text = operation.text;
  }
  if (Object.hasOwn(operation, "start")) caption.start = finiteNonNegative(operation.start, "start");
  if (Object.hasOwn(operation, "end")) caption.end = finiteNonNegative(operation.end, "end");
  if (Object.hasOwn(operation, "hidden")) {
    if (typeof operation.hidden !== "boolean") invalidArgument("hidden must be a boolean");
    caption.hidden = operation.hidden;
  }
  requireCaptionRange(caption.start, caption.end);
  project.script = (project.captionSegments || []).map((item) => item.text).join("\n");
}

function duplicateCaption(project, operation) {
  project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const source = findById(project.captionSegments, operation.clipId, "Caption clip");
  const id = requireNewClipId(project, operation.newClipId);
  const index = project.captionSegments.indexOf(source);
  let fontId = project.captionStyle?.fontId || "default";
  for (const caption of project.captionSegments.slice(0, index + 1)) fontId = caption.fontId || fontId;
  const copy = { ...structuredClone(source), id, fontId, text: `${source.text} 副本` };
  project.captionSegments.splice(index + 1, 0, copy);
  project.script = project.captionSegments.map(item => item.text).join("\n");
}

function splitCaption(project, operation) {
  project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const source = findById(project.captionSegments, operation.clipId, "Caption clip");
  const rightId = requireNewClipId(project, operation.rightClipId);
  const at = finiteNonNegative(operation.at, "at");
  if (at <= source.start + MIN_TIMED_CAPTION_SECONDS || at >= source.end - MIN_TIMED_CAPTION_SECONDS) invalidArgument("Caption cut must leave more than 0.2 seconds on each side");
  const [left, right] = splitCaptionSegmentState(source, at);
  left.id = source.id;
  right.id = rightId;
  const index = project.captionSegments.findIndex(item => item.id === source.id);
  project.captionSegments.splice(index, 1, left, right);
  project.script = project.captionSegments.map(item => item.text).join("\n");
}

function addCaption(project, operation) {
  project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const id = requireNewClipId(project, operation.clipId);
  const captions = Array.isArray(project.captionSegments) ? project.captionSegments : [];
  if (captions.some((caption) => caption.id === id)) {
    throw Object.assign(new Error(`Caption clip already exists: ${id}`), { code: "CLIP_ALREADY_EXISTS" });
  }
  if (typeof operation.text !== "string") throw Object.assign(new Error("text must be a string"), { code: "INVALID_ARGUMENT" });
  const start = finiteNonNegative(operation.start, "start");
  const end = finiteNonNegative(operation.end, "end");
  requireCaptionRange(start, end);
  let audioSegmentId = "";
  if (operation.audioClipId && operation.visualClipId) invalidArgument("A caption cannot bind both audio and visual clips.");
  if (operation.audioClipId) audioSegmentId = findById(project.audioSegments, operation.audioClipId, "Audio clip").id;
  const visualSegmentId = operation.visualClipId ? findById(project.visualSegments, operation.visualClipId, "Visual clip").id : "";
  const previousCaption = [...captions]
    .sort((left, right) => (Number(left.start) || 0) - (Number(right.start) || 0))
    .filter((caption) => (Number(caption.start) || 0) <= start)
    .at(-1);
  project.captionSegments = [...captions, {
    id,
    text: operation.text,
    start,
    end,
    fontId: operation.fontId || previousCaption?.fontId || project.captionStyle?.fontId || "default",
    ...(audioSegmentId ? { audioSegmentId } : {}),
    ...(visualSegmentId ? { visualSegmentId } : {}),
  }].sort((left, right) => (Number(left.start) || 0) - (Number(right.start) || 0));
  project.script = project.captionSegments.map((item) => item.text).join("\n");
  project.captionsEnabled = true;
}

function deleteClip(project, operation) {
  const collections = { caption: "captionSegments", captions: "captionSegments", ...TIMED_COLLECTIONS };
  const key = collections[operation.track];
  if (!key) throw Object.assign(new Error(`Unsupported clip track: ${operation.track}`), { code: "UNSUPPORTED_TRACK" });
  if (key === "captionSegments") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  if (operation.track === "audio") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  findById(project[key], operation.clipId, `${operation.track === "caption" ? "Caption" : "Audio"} clip`);
  project[key] = project[key].filter((item) => item.id !== operation.clipId);
  if (key === "captionSegments") {
    project.script = project.captionSegments.map((item) => item.text).join("\n");
  } else if (operation.track === "audio") {
    project.captionSegments = (project.captionSegments || []).map((caption) => (
      caption.audioSegmentId === operation.clipId || caption.detachedAudioSegmentId === operation.clipId
        ? { ...caption, audioSegmentId: "", detachedAudioSegmentId: "" }
        : caption
    ));
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  } else if (operation.track === "music" && !project.musicSegments.length) {
    project.musicName = "";
    project.musicDuration = 0;
    project.musicStart = 0;
  }
}

function captionEditScope(project, operation) {
  if (!["default", "current"].includes(operation.scope)) invalidArgument("scope must be default or current");
  if (operation.scope === "default") {
    if (Object.hasOwn(operation, "clipId")) invalidArgument("Default caption edits must not specify clipId");
    return null;
  }
  return findById(project.captionSegments, operation.clipId, "Caption clip");
}

function setCaptionStyle(project, operation) {
  const caption = captionEditScope(project, operation);
  const style = operation.style;
  if (!style || typeof style !== "object" || Array.isArray(style) || !Object.keys(style).length) invalidArgument("style must contain at least one supported property");
  for (const [key, value] of Object.entries(style)) {
    const rule = CAPTION_STYLE_PROPERTY_SCHEMA[key];
    if (!rule || typeof value !== rule.type || rule.enum && !rule.enum.includes(value)
      || rule.type === "number" && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)
      || rule.pattern && !new RegExp(rule.pattern).test(value)) invalidArgument(`Invalid caption style property: ${key}`);
  }
  if (caption) {
    caption.styleOverrides = { ...(caption.styleOverrides || {}), ...style };
    return;
  }
  const { captionSize, ...visualStyle } = style;
  project.captionStyle = { ...(project.captionStyle || {}), ...visualStyle };
  if (captionSize !== undefined) project.captionSize = captionSize;
  project.captionStylePresetId = "modified";
  // Default-style edits have the same semantics as the editor inspector:
  // edited properties become shared; unrelated per-caption overrides survive.
  project.captionSegments = (project.captionSegments || []).map((item) => {
    const next = { ...item, styleOverrides: { ...(item.styleOverrides || {}) } };
    for (const key of Object.keys(style)) delete next.styleOverrides[key];
    if (Object.hasOwn(style, "fontId")) delete next.fontId;
    if (!Object.keys(next.styleOverrides).length) delete next.styleOverrides;
    return next;
  });
}

function saveCaptionStylePreset(project, operation) {
  const caption = captionEditScope(project, operation);
  if (typeof operation.name !== "string" || !operation.name.trim() || operation.name.length > 240) invalidArgument("Caption preset name is required (maximum 240 characters)");
  const id = `caption-style-${operation.id}`;
  if ((project.captionStylePresets || []).some(preset => preset.id === id)) invalidArgument("Caption preset already exists");
  const style = caption ? resolveCaptionStyleForSegment(project.captionStyle, caption) : project.captionStyle;
  const size = caption ? resolveCaptionSizeForSegment(project.captionSize, caption) : project.captionSize;
  const preset = buildCaptionPresetSnapshot(operation.name.trim(), style, size, id);
  project.captionStylePresets = [...(project.captionStylePresets || []), preset];
  if (!caption) project.captionStylePresetId = preset.id;
}

function applyCaptionStylePreset(project, operation) {
  const caption = captionEditScope(project, operation);
  const preset = getCaptionStylePreset(operation.presetId)
    || (project.captionStylePresets || []).find(item => item.id === operation.presetId);
  if (!preset) invalidArgument("Caption style preset not found");
  if (caption) {
    caption.styleOverrides = {
      ...(caption.styleOverrides || {}),
      ...Object.fromEntries(CAPTION_VISUAL_STYLE_KEYS.map(key => [key, preset.style?.[key] ?? project.captionStyle?.[key]]).filter(([, value]) => value !== undefined)),
      captionSize: preset.captionSize,
    };
  } else {
    project.captionStyle = applyCaptionPresetToStyle(project.captionStyle, preset);
    project.captionSize = preset.captionSize;
    project.captionStylePresetId = preset.id;
    project.captionSegments = (project.captionSegments || []).map(({ styleOverrides: _styleOverrides, fontId: _fontId, ...caption }) => caption);
  }
}

function resetCaptionOverrides(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  const property = operation.property;
  if (property !== undefined && property !== "placement" && !Object.hasOwn(CAPTION_STYLE_PROPERTY_SCHEMA, property)) invalidArgument("Unsupported caption override property");
  if (property === undefined) {
    delete caption.placement;
    delete caption.styleOverrides;
    delete caption.fontId;
  } else if (property === "placement") {
    delete caption.placement;
  } else {
    const overrides = { ...(caption.styleOverrides || {}) };
    delete overrides[property];
    if (Object.keys(overrides).length) caption.styleOverrides = overrides;
    else delete caption.styleOverrides;
    if (property === "fontId") delete caption.fontId;
  }
}

function captionPlacement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["x", "y"].includes(key))
    || [value.x, value.y].some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate) || coordinate < 10 || coordinate > 90)) {
    invalidArgument("Caption placement is a center point with x and y percentages from 10 to 90");
  }
  return { x: value.x, y: value.y };
}

function setSharedCaptionPlacement(project, placement) {
  project.captionPlacement = captionPlacement(placement);
  project.captionPosition = [["top", 18], ["middle", 50], ["bottom", 78]]
    .find(([, y]) => Math.abs(placement.x - 50) < 4 && Math.abs(placement.y - y) < 4)?.[0] || "custom";
  project.captionSegments = (project.captionSegments || []).map(({ placement: _placement, ...caption }) => caption);
}

function setCaptionPosition(project, operation) {
  const caption = captionEditScope(project, operation);
  const placement = captionPlacement(operation.placement);
  if (caption) caption.placement = placement;
  else setSharedCaptionPlacement(project, placement);
}

function syncCaptionPosition(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  setSharedCaptionPlacement(project, caption.placement || project.captionPlacement || { x: 50, y: 78 });
}

export const STICKER_TRANSFORM_PROPERTY_SCHEMA = Object.freeze({
  x: { type: "number", minimum: 0, maximum: 100 },
  y: { type: "number", minimum: 0, maximum: 100 },
  scale: { type: "number", minimum: 0.2, maximum: 3 },
  rotation: { type: "number", minimum: -180, maximum: 180 },
  opacity: { type: "number", minimum: 0, maximum: 1 },
});

function addSticker(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  const asset = STICKER_LIBRARY.find(item => item.id === operation.stickerId);
  if (!asset) invalidArgument("Unknown built-in sticker");
  const start = finiteNonNegative(operation.start, "start");
  const duration = operation.duration === undefined ? DEFAULT_STICKER_SEGMENT_SECONDS : operation.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < MIN_VISUAL_SEGMENT_SECONDS || start + duration > MAX_TIMELINE_DURATION_SECONDS) invalidArgument("Invalid sticker range");
  project.stickerSegments = [...(project.stickerSegments || []), { ...createStickerSegment(asset, start, duration), id }];
  if (operation.transform !== undefined) setStickerTransform(project, { ...operation, transform: operation.transform });
}

function setStickerTransform(project, operation) {
  const clip = findById(project.stickerSegments, operation.clipId, "Sticker clip");
  const transform = operation.transform;
  if (!transform || typeof transform !== "object" || Array.isArray(transform) || !Object.keys(transform).length) invalidArgument("Sticker transform requires at least one property");
  for (const [key, value] of Object.entries(transform)) {
    const limits = Object.hasOwn(STICKER_TRANSFORM_PROPERTY_SCHEMA, key) ? STICKER_TRANSFORM_PROPERTY_SCHEMA[key] : null;
    if (!limits || typeof value !== "number" || !Number.isFinite(value) || value < limits.minimum || value > limits.maximum) invalidArgument("Invalid sticker transform");
  }
  for (const [key, value] of Object.entries(transform)) clip[key] = Math.round(value * 100) / 100;
}

function setVisualTransform(project, operation) {
  const overlay = operation.type === "overlay.set_transform";
  const clip = findById(overlay ? project.visualOverlaySegments : project.visualSegments, operation.clipId, overlay ? "Overlay clip" : "Visual clip");
  const transform = operation.transform;
  if (!transform || typeof transform !== "object" || Array.isArray(transform) || !Object.keys(transform).length) invalidArgument("transform must contain at least one supported property");
  for (const [key, value] of Object.entries(transform)) {
    const limits = NUMERIC_CLIP_PROPERTIES[key];
    if (!["x", "y", "scale", "rotation", "opacity"].includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < limits.min || value > limits.max) invalidArgument(`Invalid overlay transform property: ${key}`);
  }
  clip.baseTransform = normalizeVisualTransform({ ...(overlay ? { x: 27, y: -24, scale: 0.34 } : {}), ...(clip.baseTransform || {}), ...transform });
}

function setLinkedSourceVolume(project, operation) {
  const volume = operation.volume;
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 4) invalidArgument("Invalid linked source volume");
  if (project.sourceAudioLinked === false || !(project.sourceAudioDuration > 0)
    || !getLinkedSourceAudioSegments(project.visualSegments, project.sourceAudioAssetId, project.sourceAudioDuration).some(clip => clip.id === operation.clipId)) invalidArgument("Linked source clip is unavailable");
  findById(project.visualSegments, operation.clipId, "Visual clip").sourceAudioVolume = volume;
}

function setSourceAudioSettings(project, operation) {
  if (!(project.sourceAudioDuration > 0)) invalidArgument("Source audio is unavailable");
  const settings = operation.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || !Object.keys(settings).length
    || Object.keys(settings).some(key => !["volume", "spatialEffect", "spatialAmount"].includes(key))) invalidArgument("Invalid source audio settings");
  if (Object.hasOwn(settings, "volume") && (typeof settings.volume !== "number" || !Number.isFinite(settings.volume) || settings.volume < 0 || settings.volume > 4)) invalidArgument("Invalid source audio volume");
  if (Object.hasOwn(settings, "spatialAmount") && (typeof settings.spatialAmount !== "number" || !Number.isFinite(settings.spatialAmount) || settings.spatialAmount < 0 || settings.spatialAmount > 1)) invalidArgument("Invalid source spatial amount");
  if (Object.hasOwn(settings, "spatialEffect") && !AUDIO_SPATIAL_EFFECTS.some(effect => effect.id === settings.spatialEffect)) invalidArgument("Invalid source spatial effect");
  if (Object.hasOwn(settings, "volume")) project.sourceAudioVolume = settings.volume;
  if (Object.hasOwn(settings, "spatialEffect")) project.sourceAudioSpatialEffect = settings.spatialEffect;
  if (Object.hasOwn(settings, "spatialAmount")) project.sourceAudioSpatialAmount = settings.spatialAmount;
}

function setAudioSpatialEffect(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["audio", "music"].includes(track)) invalidArgument("Spatial audio requires an audio or music clip");
  if (!AUDIO_SPATIAL_EFFECTS.some(preset => preset.id === operation.effect)
    || typeof operation.amount !== "number" || !Number.isFinite(operation.amount)
    || operation.amount < 0 || operation.amount > 1) invalidArgument("Invalid spatial audio preset or amount");
  clip.spatialEffect = operation.effect;
  clip.spatialAmount = operation.amount;
}

function unlinkCaption(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  if (caption.audioSegmentId) caption.detachedAudioSegmentId = caption.audioSegmentId;
  caption.audioSegmentId = "";
}

function linkCaption(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  const audioId = operation.audioClipId || caption.detachedAudioSegmentId;
  if (!audioId) throw Object.assign(new Error("audioClipId is required"), { code: "INVALID_ARGUMENT" });
  const audio = findById(project.audioSegments, audioId, "Audio clip");
  caption.audioSegmentId = audio.id;
  caption.detachedAudioSegmentId = "";
  if (operation.align === true) {
    caption.start = Number(audio.start) || 0;
    caption.end = caption.start + finiteNonNegative(audio.duration, "audio duration");
  }
}

function findClipMatch(project, clipId) {
  const matches = Object.entries(TRACK_COLLECTIONS).flatMap(([track, key]) => {
    const clips = Array.isArray(project?.[key]) ? project[key] : [];
    return clips.flatMap((clip, index) => clip.id === clipId ? [{ track, key, clip, index }] : []);
  });
  if (!matches.length) throw Object.assign(new Error(`Clip not found: ${clipId}`), { code: "CLIP_NOT_FOUND" });
  if (matches.length > 1) throw Object.assign(new Error(`Clip ID is not globally unique: ${clipId}`), { code: "CLIP_ID_AMBIGUOUS" });
  return matches[0];
}

const NUMERIC_CLIP_PROPERTIES = Object.freeze({
  x: { min: -1000, max: 1000 },
  y: { min: -1000, max: 1000 },
  scale: { min: 0.1, max: 20 },
  rotation: { min: -36000, max: 36000 },
  opacity: { min: 0, max: 1 },
  volume: { min: 0, max: 4 },
  fadeIn: { min: 0, max: 1800 },
  fadeOut: { min: 0, max: 1800 },
  layer: { min: 0, max: 1000 },
});

export const VISUAL_KEYFRAME_PROPERTY_SCHEMA = Object.freeze({
  ...Object.fromEntries(["x", "y", "scale", "rotation", "opacity"].map(key => [key, {
    type: "number", minimum: NUMERIC_CLIP_PROPERTIES[key].min, maximum: NUMERIC_CLIP_PROPERTIES[key].max,
  }])),
  ...Object.fromEntries(COLOR_GRADE_KEYFRAME_KEYS.map(key => [key, {
    type: "number", minimum: key.endsWith(".hue") || key.split(".").length === 3 && key.endsWith(".saturation") ? 0 : -100,
    maximum: key.endsWith(".hue") ? 360 : 100,
  }])),
});

export const VISUAL_MASK_PROPERTY_SCHEMA = Object.freeze({
  type: { type: "string", enum: ["none", "rectangle", "rounded", "circle"] },
  inverted: { type: "boolean" },
  feather: { type: "number", minimum: 0, maximum: 40 },
  centerX: { type: "number", minimum: 0, maximum: 100 },
  centerY: { type: "number", minimum: 0, maximum: 100 },
  ...Object.fromEntries(["size", "width", "height"].map(key => [key, { type: "number", minimum: 8, maximum: 100 }])),
  cornerRadius: { type: "number", minimum: 0, maximum: 50 },
});

export const SUBJECT_EFFECT_PROPERTY_SCHEMA = Object.freeze({
  enabled: { type: "boolean" }, targetKind: { type: "string", enum: ["person", "object"] },
  analysisQuality: { type: "string", enum: ["fast", "balanced", "quality"] },
  "outline.enabled": { type: "boolean" }, "outline.color": CAPTION_STYLE_PROPERTY_SCHEMA.textColor,
  "background.visible": { type: "boolean" }, "background.color": CAPTION_STYLE_PROPERTY_SCHEMA.textColor,
  "background.mode": { type: "string", enum: ["original", "color", "blur"] },
  "background.fit": { type: "string", enum: ["cover", "contain"] },
  "material.id": { type: "string", enum: ["paper", "frosted", "halo", "chrome", "impasto", "ink"] },
  ...Object.fromEntries(Object.entries({
    "outline.width": [0, 32], "outline.opacity": [0, 1], "outline.softness": [0, 20], "outline.glow": [0, 1], "outline.glowRadius": [0, 60],
    "material.textureScale": [0.35, 3], "material.textureStrength": [0, 1], "material.irregularity": [0, 1], "material.edgeDensity": [0, 1],
    "material.grain": [0, 1], "material.diffusion": [0, 1], "material.shadowDepth": [0, 1], "material.relief": [0, 1], "material.bleed": [0, 1], "material.contrast": [0, 1], "material.ringGap": [2, 24],
    "background.opacity": [0, 1], "background.blur": [0, 80], "background.darken": [0, 1],
    "edge.feather": [0, 20], "edge.contract": [-20, 20], "edge.decontaminate": [0, 1],
  }).map(([key, [minimum, maximum]]) => [key, { type: "number", minimum, maximum }])),
  "material.rings": { type: "integer", minimum: 1, maximum: 3 },
});

export const CLICK_RIPPLE_PROPERTY_SCHEMA = Object.freeze({
  enabled: { type: "boolean" }, color: CAPTION_STYLE_PROPERTY_SCHEMA.textColor,
  meter: { type: "string", enum: ["2/4", "4/4", "3/4", "5/4", "6/8", "7/8", "9/8", "12/8"] },
  ...Object.fromEntries(Object.entries({ bpm: [30, 180], rippleDuration: [0.01, 1.4], radius: [2, 18], colorAmount: [0, 1], glow: [0, 1] })
    .map(([key, [minimum, maximum]]) => [key, { type: "number", minimum, maximum }])),
});

export const CINEMATIC_DEPTH_PROPERTY_SCHEMA = Object.freeze({
  enabled: { type: "boolean" }, inverted: { type: "boolean" },
  output: { type: "string", enum: ["cinematic", "depth-map", "relight"] },
  quality: { type: "string", enum: ["fast", "balanced", "quality"] },
  "relight.color": { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
  ...Object.fromEntries(Object.entries({ focus: [0, 1], focusRange: [0.04, 0.48], blur: [0, 40], highlightBoost: [0, 0.7],
    "relight.x": [-1, 1], "relight.y": [-1, 1], "relight.strength": [0, 1], "relight.range": [0.1, 1],
    "relight.softness": [0, 1], "relight.distance": [1, 4] }).map(([key, [minimum, maximum]]) => [key, { type: "number", minimum, maximum }])),
});

export const PHOTO_PARALLAX_PROPERTY_SCHEMA = Object.freeze({
  enabled: { type: "boolean" }, quality: CINEMATIC_DEPTH_PROPERTY_SCHEMA.quality,
  direction: { type: "string", enum: ["horizontal", "vertical", "orbit"] },
  ...Object.fromEntries(Object.entries({ strength: [0, 1], speed: [0.35, 2], zoom: [1.01, 1.16],
    foregroundDepth: [0.4, 0.92], backgroundDepth: [0.08, 0.6], edgeFeather: [0.02, 0.24] })
    .map(([key, [minimum, maximum]]) => [key, { type: "number", minimum, maximum }])),
});

function setVisualEffectProperty(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track)) invalidArgument("Effects require a visual clip");
  const subject = operation.type === "clip.set_subject_effect";
  const depth = operation.type === "clip.set_cinematic_depth", parallax = operation.type === "clip.set_photo_parallax";
  if (parallax && clip.type !== "image") invalidArgument("Photo parallax requires an image clip");
  const schema = depth ? CINEMATIC_DEPTH_PROPERTY_SCHEMA : parallax ? PHOTO_PARALLAX_PROPERTY_SCHEMA : subject ? SUBJECT_EFFECT_PROPERTY_SCHEMA : CLICK_RIPPLE_PROPERTY_SCHEMA;
  const rule = Object.hasOwn(schema, operation.property) ? schema[operation.property] : null;
  const value = operation.value;
  if (!rule || (rule.type === "integer" ? !Number.isInteger(value) : typeof value !== rule.type)
    || rule.enum && !rule.enum.includes(value)
    || rule.pattern && !new RegExp(rule.pattern).test(value)
    || ["number", "integer"].includes(rule.type) && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)) invalidArgument("Invalid effect property");
  const [key, child] = operation.property.split(".");
  const patch = child ? { [key]: { [child]: value } } : { [key]: value };
  if (depth) clip.cinematicDepth = normalizeCinematicDepth({ ...clip.cinematicDepth, ...patch,
    ...(child ? { [key]: { ...clip.cinematicDepth?.[key], ...patch[key] } } : {}) });
  else if (parallax) clip.photoParallax = normalizePhotoParallax({ ...clip.photoParallax, ...patch });
  else if (subject) clip.subjectEffect = updateSubjectEffect(clip.subjectEffect, patch);
  else clip.clickRipple = updateClickRippleEffect(clip.clickRipple, patch);
}

function applyDepthAnalysis(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || operation.prepared !== true || !operation.preparedDepth) invalidArgument("Depth analysis requires prepared source media");
  clip.depth = structuredClone(operation.preparedDepth);
}

function applyVisionCutout(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || clip.type !== "image"
    || operation.prepared !== true || !operation.preparedVision) invalidArgument("Vision cutout requires a prepared image source");
  const prepared = structuredClone(operation.preparedVision);
  clip.vision = { ...clip.vision, ...prepared, options: { ...clip.vision?.options, ...prepared.options } };
}

function applySubjectBackgroundMedia(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || operation.prepared !== true
    || !operation.preparedBackground || !["image", "video"].includes(operation.preparedBackground.mode)) {
    invalidArgument("Subject background requires prepared visual media");
  }
  clip.subjectEffect = updateSubjectEffect(clip.subjectEffect, {
    enabled: true,
    background: {
      visible: true,
      mode: operation.preparedBackground.mode,
      assetId: operation.preparedBackground.assetId,
      src: "",
      fit: operation.preparedBackground.fit,
      opacity: operation.preparedBackground.opacity,
    },
  });
}

function hasCaptionAvoidanceSubject(vision) {
  return Boolean(vision?.subject?.box || vision?.samples?.some((sample) => sample?.subject?.box));
}

function applyCaptionAvoidance(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || operation.prepared !== true
    || !operation.preparedVision || !hasCaptionAvoidanceSubject(operation.preparedVision)) {
    invalidArgument("Caption avoidance requires prepared visual analysis");
  }
  const prepared = structuredClone(operation.preparedVision);
  clip.vision = {
    ...clip.vision,
    ...prepared,
    kind: prepared.kind === "video-timeline" ? prepared.kind : clip.vision?.kind || prepared.kind,
    options: { ...clip.vision?.options, ...prepared.options, avoidCaptions: true },
  };
}

function setCaptionAvoidance(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || typeof operation.enabled !== "boolean"
    || !clip.vision || operation.enabled && !hasCaptionAvoidanceSubject(clip.vision)) {
    invalidArgument("Caption avoidance requires existing subject analysis");
  }
  clip.vision = { ...clip.vision, options: { ...clip.vision.options, avoidCaptions: operation.enabled } };
}

function applySmartFrame(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || !["image", "video"].includes(clip.type)
    || operation.prepared !== true || !operation.preparedSmartFrame) invalidArgument("Smart Frame requires prepared visual analysis");
  const smartFrame = normalizeSmartFrame(operation.preparedSmartFrame);
  if (!smartFrame) invalidArgument("Smart Frame analysis is invalid");
  clip.smartFrame = smartFrame;
}

function removeSmartFrame(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || !["image", "video"].includes(clip.type) || !normalizeSmartFrame(clip.smartFrame)) {
    invalidArgument("An existing Smart Frame is required");
  }
  delete clip.smartFrame;
}

export const VECTOR_DESIGN_PROPERTY_SCHEMA = Object.freeze({
  paletteEnabled: { type: "boolean" }, shadowEnabled: { type: "boolean" },
  ...Object.fromEntries(["primary", "secondary", "accent", "outlineColor", "shadowColor"].map(key => [key, CAPTION_STYLE_PROPERTY_SCHEMA.textColor])),
  ...Object.fromEntries(Object.entries({ opacity: [0, 1], saturation: [0, 240], brightness: [20, 200], contrast: [20, 200], outlineWidth: [0, 12], shadowBlur: [0, 40], shadowX: [-30, 30], shadowY: [-30, 30] })
    .map(([key, [minimum, maximum]]) => [key, { type: "number", minimum, maximum }])),
  blendMode: { type: "string", enum: ["source-over", "multiply", "screen", "overlay"] },
});

export const VECTOR_PART_PROPERTY_SCHEMA = Object.freeze({
  color: CAPTION_STYLE_PROPERTY_SCHEMA.textColor,
  shadowEnabled: { type: "boolean" },
  ...Object.fromEntries(Object.entries({ opacity: [0, 1], strokeWidth: [1, 120], translateX: [-1200, 1200], translateY: [-1200, 1200], scale: [0.1, 5] })
    .map(([key, [minimum, maximum]]) => [key, { type: "number", minimum, maximum }])),
});

function setVectorPart(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || !(clip.kind === "vector" || clip.vectorBody)) invalidArgument("Vector part requires a vector clip");
  const patch = operation.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) invalidArgument("Vector part requires at least one property");
  for (const [key, value] of Object.entries(patch)) {
    const rule = Object.hasOwn(VECTOR_PART_PROPERTY_SCHEMA, key) ? VECTOR_PART_PROPERTY_SCHEMA[key] : null;
    if (!rule || typeof value !== rule.type || rule.pattern && !new RegExp(rule.pattern).test(value)
      || rule.type === "number" && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)) invalidArgument("Invalid vector part property");
  }
  const document = createEditableVectorDocument(buildVectorDesignPatch(clip, clip.vectorDesign).vectorBody);
  const part = document.parts.find(item => item.id === operation.partId);
  if (!document.supported || !part) invalidArgument("Inspect and select an existing vector part");
  if (patch.color !== undefined && !part.supportsColor || patch.strokeWidth !== undefined && !part.supportsStroke) invalidArgument("Property unsupported by this vector part");
  clip.vectorBody = updateVectorPart(document.body, part.id, patch).body;
}

function setVectorDesign(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || !(clip.kind === "vector" || clip.vectorBody)) invalidArgument("Vector design requires a vector clip");
  const design = operation.design;
  if (!design || typeof design !== "object" || Array.isArray(design) || !Object.keys(design).length) invalidArgument("Vector design requires at least one property");
  for (const [key, value] of Object.entries(design)) {
    const rule = Object.hasOwn(VECTOR_DESIGN_PROPERTY_SCHEMA, key) ? VECTOR_DESIGN_PROPERTY_SCHEMA[key] : null;
    if (!rule || typeof value !== rule.type || rule.enum && !rule.enum.includes(value)
      || rule.pattern && !new RegExp(rule.pattern).test(value)
      || rule.type === "number" && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)) invalidArgument("Invalid vector design property");
  }
  clip.vectorDesign = normalizeVectorDesign({ ...clip.vectorDesign, ...design });
}

function setVisualAppearance(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track)) invalidArgument("Appearance requires a visual clip");
  if (operation.type === "clip.set_filter") {
    if (!FILTER_OPTIONS.some(option => option.id === operation.filterId)) invalidArgument("Unknown filter");
    clip.filterId = operation.filterId;
  } else if (operation.type === "clip.set_animation") {
    if (!["in", "out"].includes(operation.phase) || !VISUAL_CLIP_ANIMATION_OPTIONS.some(option => option.id === operation.animationId)
      || typeof operation.duration !== "number" || !Number.isFinite(operation.duration) || operation.duration < 0.1 || operation.duration > 3) invalidArgument("Invalid clip animation");
    clip.animation = normalizeVisualClipAnimation({ ...clip.animation, [operation.phase]: { id: operation.animationId, duration: operation.duration } });
  } else if (operation.type === "clip.set_color_grade") {
    if (!COLOR_GRADE_KEYFRAME_KEYS.includes(operation.property)) invalidArgument("Unknown color grade property");
    const limits = VISUAL_KEYFRAME_PROPERTY_SCHEMA[operation.property];
    if (typeof operation.value !== "number" || !Number.isFinite(operation.value) || operation.value < limits.minimum || operation.value > limits.maximum) invalidArgument("Invalid color grade value");
    const grade = normalizeColorGrade(clip.colorGrade || {});
    const [, key, part] = operation.property.split(".");
    if (part) grade[key][part] = operation.value;
    else grade[key] = operation.value;
    clip.colorGrade = normalizeColorGrade(grade);
  } else {
    const patch = operation.mask;
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) invalidArgument("Mask requires at least one property");
    for (const [key, value] of Object.entries(patch)) {
      const rule = Object.hasOwn(VISUAL_MASK_PROPERTY_SCHEMA, key) ? VISUAL_MASK_PROPERTY_SCHEMA[key] : null;
      if (!rule || typeof value !== rule.type || rule.enum && !rule.enum.includes(value)
        || rule.type === "number" && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)) invalidArgument("Invalid mask property");
    }
    clip.mask = { ...clip.mask, ...patch };
  }
}

function editVisualKeyframe(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track)) invalidArgument("Keyframes require a visual clip");
  if (typeof operation.time !== "number" || !Number.isFinite(operation.time) || operation.time < 0 || operation.time > clip.duration) invalidArgument("Keyframe time is outside the clip");
  const property = operation.property;
  if (property !== undefined && !Object.hasOwn(VISUAL_KEYFRAME_PROPERTY_SCHEMA, property)) invalidArgument("Unknown keyframe property");
  if (operation.type === "clip.keyframe_remove") {
    clip.keyframes = property === undefined ? (clip.keyframes ?? []).filter(frame => Math.abs(frame.time - operation.time) > 0.04)
      : removeVisualPropertyKeyframe(clip.keyframes, operation.time, property);
    return;
  }
  const limits = VISUAL_KEYFRAME_PROPERTY_SCHEMA[property];
  if (!limits || typeof operation.value !== "number" || !Number.isFinite(operation.value)
    || operation.value < limits.minimum || operation.value > limits.maximum) invalidArgument("Invalid keyframe value");
  clip.keyframes = upsertVisualPropertyKeyframe(clip.keyframes, operation.time, property, operation.value);
}

function setClipProperty(project, operation) {
  const { clip } = findClipMatch(project, operation.clipId);
  const limits = NUMERIC_CLIP_PROPERTIES[operation.property];
  if (!limits) throw Object.assign(new Error(`Unsupported clip property: ${operation.property}`), { code: "UNSUPPORTED_PROPERTY" });
  if (typeof operation.value !== "number" || !Number.isFinite(operation.value) || operation.value < limits.min || operation.value > limits.max) {
    throw Object.assign(new Error(`${operation.property} must be between ${limits.min} and ${limits.max}`), { code: "INVALID_ARGUMENT" });
  }
  clip[operation.property] = operation.value;
}

function setVisualSpeedCurve(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || clip.type !== "video") invalidArgument("Speed curves require a video clip");
  const curve = operation.curve;
  if (!curve || typeof curve !== "object" || Array.isArray(curve)
    || Object.keys(curve).some(key => !["smooth", "points"].includes(key))
    || typeof curve.smooth !== "boolean" || !Array.isArray(curve.points)
    || curve.points.length < 2 || curve.points.length > 8) invalidArgument("Invalid speed curve");
  curve.points.forEach((point, index) => {
    if (!point || typeof point !== "object" || Array.isArray(point)
      || Object.keys(point).some(key => !["progress", "rate"].includes(key))
      || !Number.isFinite(point.progress) || point.progress < 0 || point.progress > 1
      || !Number.isFinite(point.rate) || point.rate < 0.25 || point.rate > 4
      || index > 0 && point.progress - curve.points[index - 1].progress < 0.005
      || index === 0 && point.progress !== 0
      || index === curve.points.length - 1 && point.progress !== 1) invalidArgument("Invalid speed curve point");
  });
  Object.assign(clip, updateVisualSegmentSpeedCurve(clip, curve));
}

export const ENHANCEMENT_PROCESSING_PROPERTIES = {
  preset: { type: "string", enum: ["auto", "light", "balanced", "strong"] },
  strength: { type: "number", minimum: 0, maximum: 1 },
  backend: { type: "string", maxLength: 256 },
  pipeline: { type: "string", enum: ["webcodecs-stream", "png-ffmpeg-fallback"] },
  frameRate: { type: "number", minimum: 1, maximum: 60 },
  reusedFrames: { type: "integer", minimum: 0 }, audioPreserved: { type: "boolean" },
};

function applyEnhancementAsset(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || !(clip.type === "video" || clip.type === "image" && operation.mode === "nanovsr-644k") || operation.prepared !== true
    || !operation.preparedEnhancement || !["smart-denoise-drunet", "nanovsr-644k", "remaster-drunet-full"].includes(operation.mode)) invalidArgument("Prepared video enhancement required");
  const processing = operation.processing;
  if (processing !== undefined && operation.mode === "nanovsr-644k") {
    if (!processing || typeof processing !== "object" || Array.isArray(processing)
      || Object.keys(processing).some(key => !["backend", "frameRate", "totalFrames"].includes(key))
      || typeof processing.backend !== "string" || processing.backend.length > 256) invalidArgument("Invalid NanoVSR processing details");
    if (clip.type === "video" ? !Number.isInteger(processing.frameRate) || processing.frameRate < 1 || processing.frameRate > 15
      || !Number.isSafeInteger(processing.totalFrames) || processing.totalFrames < 1
      : processing.frameRate !== undefined || processing.totalFrames !== undefined) invalidArgument("Invalid NanoVSR frame metadata");
  } else if (processing !== undefined) {
    if (!processing || typeof processing !== "object" || Array.isArray(processing)
      || Object.keys(processing).some(key => !Object.hasOwn(ENHANCEMENT_PROCESSING_PROPERTIES, key) && key !== "analysis")) invalidArgument("Invalid enhancement processing details");
    for (const [key, limits] of Object.entries(ENHANCEMENT_PROCESSING_PROPERTIES)) {
      const value = processing[key];
      if ((limits.type === "integer" ? !Number.isSafeInteger(value) : typeof value !== limits.type)
        || typeof value === "number" && (!Number.isFinite(value) || value < limits.minimum || limits.maximum !== undefined && value > limits.maximum)
        || limits.enum && !limits.enum.includes(value) || limits.maxLength && value.length > limits.maxLength) invalidArgument("Invalid enhancement processing value");
    }
    if (processing.analysis !== null && (!processing.analysis || typeof processing.analysis !== "object" || Array.isArray(processing.analysis)
      || Object.keys(processing.analysis).some(key => !["score", "strength"].includes(key))
      || ["score", "strength"].some(key => !Number.isFinite(processing.analysis[key]) || processing.analysis[key] < 0 || processing.analysis[key] > 1))) invalidArgument("Invalid enhancement analysis");
  }
  clip.enhancement = { ...operation.preparedEnhancement, ...processing };
  const source = clip.enhancement.processed;
  for (const key of ["sourceStart", "sourceDuration", "width", "height"]) clip[key] = source[key];
}

function setEnhancementEnabled(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || typeof operation.enabled !== "boolean" || !clip.enhancement) invalidArgument("An existing visual enhancement is required");
  const source = operation.enabled ? clip.enhancement.processed : clip.enhancement.original;
  if (!source) invalidArgument("Enhancement comparison source is unavailable");
  for (const key of ["sourceStart", "sourceDuration", "width", "height"]) {
    if (source[key] !== undefined) clip[key] = source[key];
  }
  clip.enhancement = { ...clip.enhancement, enabled: operation.enabled };
}

function setRepairEnabled(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || !["image", "video"].includes(clip.type)
    || typeof operation.enabled !== "boolean" || clip.repair?.mode !== "migan-256-webgpu") invalidArgument("An existing MI-GAN repair is required");
  const source = operation.enabled ? clip.repair.processed : clip.repair.original;
  if (!source) invalidArgument("Repair comparison source is unavailable");
  for (const key of ["sourceStart", "sourceDuration", "width", "height"]) {
    if (source[key] !== undefined) clip[key] = source[key];
  }
  clip.repair = { ...clip.repair, enabled: operation.enabled };
}

function applyRepairAsset(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track) || !["image", "video"].includes(clip.type)
    || operation.prepared !== true || !operation.preparedRepair) invalidArgument("Prepared visual repair required");
  const duration = (Number(clip.sourceDuration) || clip.duration * (Number(clip.playbackRate) || 1)) / (Number(clip.playbackRate) || 1);
  validateMiganRegions(operation.regions, clip.type === "video", duration);
  clip.repair = { ...operation.preparedRepair, selection: structuredClone(operation.regions[0].selection),
    regions: operation.regions.map((region, index) => ({ id: `${operation.id}-region-${index}`, start: 0, end: clip.duration, keyframes: [], ...structuredClone(region) })) };
  for (const key of ["sourceStart", "sourceDuration", "width", "height"]) clip[key] = clip.repair.processed[key];
}

function setClipSpeed(project, operation) {
  const match = findClipMatch(project, operation.clipId);
  if (match.track === "captions" || match.track === "stickers" || (match.track === "visuals" && match.clip.type !== "video") || (match.track === "overlays" && match.clip.type !== "video")) {
    throw Object.assign(new Error(`Speed is unsupported for ${match.track} clip ${operation.clipId}`), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const speed = finitePositive(operation.speed, "speed");
  if (speed < 0.25 || speed > 4) throw Object.assign(new Error("speed must be between 0.25 and 4"), { code: "INVALID_ARGUMENT" });
  const clip = match.clip;
  if (["visuals", "overlays"].includes(match.track)) {
    if (clip.reversed || clip.reverse) throw Object.assign(new Error("Reverse timing requires its original editor"), { code: "UNSUPPORTED_TIMING" });
    Object.assign(clip, updateVisualSegmentPlaybackRate(clip, speed));
    return;
  }
  if (clip.speedCurve?.enabled || clip.reversed || clip.reverse) throw Object.assign(new Error("Complex timing requires its original editor"), { code: "UNSUPPORTED_TIMING" });
  const previousDuration = finitePositive(Number(clip.duration), "clip duration");
  const previousRate = visualPlaybackRate(clip);
  const sourceDuration = Math.max(0.001, Number(clip.sourceDuration) || previousDuration * previousRate);
  const duration = sourceDuration / speed;
  clip.playbackRate = speed;
  clip.sourceDuration = sourceDuration;
  clip.duration = duration;
  if (Array.isArray(clip.keyframes)) {
    const timeScale = duration / previousDuration;
    clip.keyframes = clip.keyframes.map((frame) => ({ ...frame, time: Math.max(0, Number(frame.time) || 0) * timeScale }));
  }
  if (match.track === "audio") {
    const origin = Number(clip.start) || 0, scale = duration / previousDuration;
    project.captionSegments = (project.captionSegments || []).map(caption => {
      if (caption.audioSegmentId !== clip.id) return caption;
      const start = origin + (Number(caption.start) - origin) * scale;
      const end = origin + (Number(caption.end) - origin) * scale;
      requireCaptionRange(start, end);
      return { ...caption, start, end, ...(Array.isArray(caption.words) ? {
        words: caption.words.map(word => ({ ...word, start: origin + (word.start - origin) * scale, end: origin + (word.end - origin) * scale })),
      } : {}) };
    });
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  }
}

function setClipMuted(project, operation) {
  if (typeof operation.muted !== "boolean") throw Object.assign(new Error("muted must be a boolean"), { code: "INVALID_ARGUMENT" });
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "audio", "overlays", "music"].includes(track)) {
    throw Object.assign(new Error(`Mute is unsupported for ${track} clips`), { code: "UNSUPPORTED_TRACK" });
  }
  if ((track === "visuals" || track === "overlays") && clip.type !== "video") {
    throw Object.assign(new Error("Mute is supported only for video or audio clips"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  if (track === "visuals") clip.sourceAudioDisabled = operation.muted;
  clip.muted = operation.muted;
}

const TRACK_STATE_KEYS = Object.freeze({
  visuals: "image", image: "image",
  captions: "caption", caption: "caption",
  audio: "audio",
  stickers: "sticker", sticker: "sticker",
  overlays: "overlay", overlay: "overlay",
  source: "source",
  music: "music",
});

function setTrackState(project, operation, stateKey) {
  let track = TRACK_STATE_KEYS[operation.track];
  if (!track) throw Object.assign(new Error(`Unknown track: ${operation.track}`), { code: "TRACK_NOT_FOUND" });
  if (operation.clipId !== undefined) {
    if (track !== "audio") invalidArgument("clipId lane targeting requires audio track");
    const clip = findById(project.audioSegments, operation.clipId, "Audio clip");
    track = getTimedSegmentLaneStateKey(project.audioSegments, clip.id);
  }
  const value = operation[stateKey];
  if (typeof value !== "boolean") throw Object.assign(new Error(`${stateKey} must be a boolean`), { code: "INVALID_ARGUMENT" });
  const projectKey = stateKey === "visible" ? "trackVisibility" : "trackLocks";
  project[projectKey] = { ...(project[projectKey] || {}), [track]: value };
}

function setProjectRatio(project, operation) {
  const supportedRatios = new Set(["16:9", "9:16", "1:1", "4:5"]);
  if (!supportedRatios.has(operation.ratio)) throw Object.assign(new Error(`Unsupported project ratio: ${operation.ratio}`), { code: "INVALID_RATIO" });
  project.ratioId = operation.ratio;
}

function setProjectFit(project, operation) {
  if (!["contain", "cover"].includes(operation.fitMode)) invalidArgument("fitMode must be contain or cover");
  project.fitMode = operation.fitMode;
}

function requireMarkerId(value) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 160) {
    throw Object.assign(new Error("markerId must be a non-empty string of at most 160 characters without surrounding whitespace"), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function markerNumber(value, field) {
  const result = finiteNonNegative(value, field);
  if (result > MAX_TIMELINE_MARKER_SECONDS) {
    throw Object.assign(new Error(`${field} must not exceed ${MAX_TIMELINE_MARKER_SECONDS} seconds`), { code: "INVALID_ARGUMENT" });
  }
  return result;
}

function markerString(value, field, maximumLength) {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw Object.assign(new Error(`${field} must be a string of at most ${maximumLength} characters`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function markerKind(value) {
  if (!TIMELINE_MARKER_TYPES.includes(value)) {
    throw Object.assign(new Error(`markerType must be one of ${TIMELINE_MARKER_TYPES.join(", ")}`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function markerColor(value) {
  if (!TIMELINE_MARKER_COLORS.includes(value)) {
    throw Object.assign(new Error(`color must be one of ${TIMELINE_MARKER_COLORS.join(", ")}`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function markerEntries(project) {
  const raw = Array.isArray(project?.timelineMarkers) ? project.timelineMarkers : [];
  const indices = raw.flatMap((item, index) => item && typeof item === "object" && !Array.isArray(item) ? [index] : []);
  return normalizeTimelineMarkers(raw).map((marker, index) => ({ marker, index: indices[index] }));
}

function findMarkerEntry(project, markerId) {
  const markers = Array.isArray(project.timelineMarkers) ? project.timelineMarkers : [];
  const index = markers.findIndex((marker) => marker.id === markerId);
  if (index < 0) throw Object.assign(new Error(`Marker not found: ${markerId}`), { code: "MARKER_NOT_FOUND" });
  return { marker: markers[index], index };
}

function nextMarker(operation, markerId, previous = null) {
  const has = (field) => Object.hasOwn(operation, field);
  const type = has("markerType") ? markerKind(operation.markerType) : previous?.type || "marker";
  const time = has("time") ? markerNumber(operation.time, "time") : previous ? previous.time : markerNumber(undefined, "time");
  const marker = {
    id: markerId,
    type,
    time,
    title: has("title") ? markerString(operation.title, "title", 240) : previous?.title || "",
    notes: has("notes") ? markerString(operation.notes, "notes", 20000) : previous?.notes || "",
    color: has("color") ? markerColor(operation.color) : previous?.color || "cyan",
  };
  if (type === "range") {
    const endTime = has("endTime") ? markerNumber(operation.endTime, "endTime")
      : previous?.type === "range" ? markerNumber(has("time") ? time + Math.max(0.001, previous.endTime - previous.time) : previous.endTime, "endTime")
        : markerNumber(undefined, "endTime");
    const timeTolerance = Number.EPSILON * Math.max(1, time, endTime) * 4;
    if (endTime <= time || endTime - time < 0.001 - timeTolerance) {
      throw Object.assign(new Error("A range marker must span at least 0.001 seconds"), { code: "INVALID_RANGE" });
    }
    marker.endTime = endTime;
  } else if (has("endTime")) {
    throw Object.assign(new Error("endTime is supported only for range markers"), { code: "INVALID_ARGUMENT" });
  }
  return marker;
}

function addMarker(project, operation) {
  const markerId = requireMarkerId(operation.markerId);
  if ((project.timelineMarkers || []).some((marker) => marker.id === markerId)) {
    throw Object.assign(new Error(`Marker already exists: ${markerId}`), { code: "MARKER_ALREADY_EXISTS" });
  }
  const marker = nextMarker(operation, markerId);
  project.timelineMarkers = [...(Array.isArray(project.timelineMarkers) ? project.timelineMarkers : []), marker];
}

function updateMarker(project, operation) {
  const markerId = requireMarkerId(operation.markerId);
  const { marker, index } = findMarkerEntry(project, markerId);
  const updated = { ...project.timelineMarkers[index], ...nextMarker(operation, markerId, marker) };
  if (updated.type !== "range") delete updated.endTime;
  project.timelineMarkers[index] = updated;
}

function deleteMarker(project, operation) {
  const markerId = requireMarkerId(operation.markerId);
  const { index } = findMarkerEntry(project, markerId);
  project.timelineMarkers.splice(index, 1);
}

const reducers = {
  "asset.import": importAsset,
  "asset.insert": insertPreparedAsset,
  "timed.move": moveTimed,
  "timed.resize": resizeTimed,
  "timed.trim": trimTimed,
  "visual.trim": trimVisual,
  "visual.split": splitVisual,
  "visual.reorder": reorderVisual,
  "visual.append": appendVisual,
  "visual.insert": insertVisual,
  "visual.delete": deleteVisual,
  "visual.duplicate": duplicateVisual,
  "overlay.add": addOverlay,
  "overlay.set_transform": setVisualTransform,
  "visual.set_transform": setVisualTransform,
  "transition.set": setTransition,
  "caption.add": addCaption,
  "caption.import_srt": importSrtCaptions,
  "caption.set_enabled": setCaptionsEnabled,
  "caption.update": updateCaption,
  "caption.set_style": setCaptionStyle,
  "caption.apply_preset": applyCaptionStylePreset,
  "caption.save_preset": saveCaptionStylePreset,
  "track.set_source_audio": setSourceAudioSettings,
  "source.set_volume": setLinkedSourceVolume,
  "sticker.set_transform": setStickerTransform,
  "clip.set_vector_design": setVectorDesign,
  "clip.set_vector_part": setVectorPart,
  "sticker.add": addSticker,
  "caption.split": splitCaption,
  "caption.duplicate": duplicateCaption,
  "timed.split": splitTimed,
  "timed.duplicate": duplicateTimed,
  "caption.reset_overrides": resetCaptionOverrides,
  "caption.set_position": setCaptionPosition,
  "caption.sync_position": syncCaptionPosition,
  "caption.delete": (project, operation) => deleteClip(project, { ...operation, track: "caption" }),
  "caption.unlink_audio": unlinkCaption,
  "caption.link_audio": linkCaption,
  "marker.add": addMarker,
  "marker.update": updateMarker,
  "marker.delete": deleteMarker,
  "clip.delete": deleteClip,
  "clip.set_property": setClipProperty,
  "clip.set_speed": setClipSpeed,
  "clip.set_speed_curve": setVisualSpeedCurve,
  "clip.set_enhancement_enabled": setEnhancementEnabled,
  "clip.set_repair_enabled": setRepairEnabled,
  "clip.apply_repair": applyRepairAsset,
  "clip.apply_vision_cutout": applyVisionCutout,
  "clip.set_subject_background_media": applySubjectBackgroundMedia,
  "clip.apply_caption_avoidance": applyCaptionAvoidance,
  "clip.set_caption_avoidance": setCaptionAvoidance,
  "clip.apply_smart_frame": applySmartFrame,
  "clip.remove_smart_frame": removeSmartFrame,
  "clip.apply_depth_analysis": applyDepthAnalysis,
  "clip.apply_enhancement": applyEnhancementAsset,
  "clip.set_muted": setClipMuted,
  "clip.set_spatial": setAudioSpatialEffect,
  "clip.keyframe_set": editVisualKeyframe,
  "clip.keyframe_remove": editVisualKeyframe,
  "clip.set_filter": setVisualAppearance,
  "clip.set_animation": setVisualAppearance,
  "clip.set_color_grade": setVisualAppearance,
  "clip.set_mask": setVisualAppearance,
  "clip.set_cinematic_depth": setVisualEffectProperty,
  "clip.set_photo_parallax": setVisualEffectProperty,
  "clip.set_subject_effect": setVisualEffectProperty,
  "clip.set_click_ripple": setVisualEffectProperty,
  "track.set_visibility": (project, operation) => setTrackState(project, operation, "visible"),
  "track.set_locked": (project, operation) => setTrackState(project, operation, "locked"),
  "project.set_ratio": setProjectRatio,
  "project.set_fit": setProjectFit,
};

export function validateCommandPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return failure("INVALID_PLAN", "Plan must be an object");
  if (plan.schemaVersion !== PROJECT_COMMAND_SCHEMA_VERSION) return failure("UNSUPPORTED_SCHEMA", "schemaVersion must be 1");
  if (!Number.isInteger(plan.baseRevision) || plan.baseRevision < 0) return failure("INVALID_PLAN", "baseRevision must be a non-negative integer");
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) return failure("INVALID_PLAN", "operations must be a non-empty array");
  const ids = new Set();
  for (const operation of plan.operations) {
    if (!operation || typeof operation.id !== "string" || !operation.id.trim()) return failure("INVALID_PLAN", "Every operation requires an id");
    if (ids.has(operation.id)) return failure("DUPLICATE_OPERATION_ID", `Duplicate operation id: ${operation.id}`, operation.id);
    ids.add(operation.id);
    if (!Object.hasOwn(reducers, operation.type)) return failure("UNKNOWN_OPERATION", `Unknown operation type: ${operation.type}`, operation.id);
  }
  return { ok: true };
}

export function inspectProject(project) {
  const state = commandState(project);
  const captions = resolveProjectCaptions(project);
  const audio = Array.isArray(project?.audioSegments) ? project.audioSegments : [];
  const visuals = Array.isArray(project?.visualSegments) ? project.visualSegments : [];
  const stickers = Array.isArray(project?.stickerSegments) ? project.stickerSegments : [];
  const overlays = Array.isArray(project?.visualOverlaySegments) ? project.visualOverlaySegments : [];
  const music = Array.isArray(project?.musicSegments) ? project.musicSegments : [];
  const markers = normalizeTimelineMarkers(project?.timelineMarkers);
  const visualDuration = visuals.reduce((total, item) => total + Math.max(0, Number(item.duration) || 0), 0);
  const duration = [visualDuration, ...captions.map((item) => Number(item.end) || 0), ...audio.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0)),
    ...stickers.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0)),
    ...overlays.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0)),
    ...music.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0))]
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: state.revision,
    duration,
    ratio: project?.ratioId || "16:9",
    tracks: { captions: captions.length, audio: audio.length, visuals: visuals.length, stickers: stickers.length, overlays: overlays.length, music: music.length },
    markers: { count: markers.length, byType: Object.fromEntries(TIMELINE_MARKER_TYPES.map((type) => [type, markers.filter((marker) => marker.type === type).length])) },
    appliedOperationIds: state.appliedOperationIds,
    warnings: audio.length ? [] : ["Project has no serialized voiceover clips"],
  };
}

const TRACK_COLLECTIONS = Object.freeze({
  visuals: "visualSegments",
  captions: "captionSegments",
  audio: "audioSegments",
  stickers: "stickerSegments",
  overlays: "visualOverlaySegments",
  music: "musicSegments",
});

function clipSummary(track, clip, index, visualStart = 0) {
  if (track === "visuals") {
    const duration = Math.max(0, Number(clip.duration) || 0);
    return { id: clip.id, index, type: clip.type || "image", start: visualStart, end: visualStart + duration, duration,
      assetId: clip.assetId || "", name: clip.name || "" };
  }
  if (track === "captions") {
    const start = Math.max(0, Number(clip.start) || 0);
    const end = Math.max(start, Number(clip.end) || start);
    return { id: clip.id, index, start, end, duration: end - start, text: clip.text || "", audioSegmentId: clip.audioSegmentId || "" };
  }
  const start = Math.max(0, Number(clip.start) || 0);
  const duration = Math.max(0, Number(clip.duration) || 0);
  return { id: clip.id, index, start, end: start + duration, duration, name: clip.name || "" };
}

export function inspectTrack(project, track) {
  const key = TRACK_COLLECTIONS[track];
  if (!key) throw Object.assign(new Error(`Unknown track: ${track}`), { code: "TRACK_NOT_FOUND" });
  const clips = track === "captions" ? resolveProjectCaptions(project) : Array.isArray(project?.[key]) ? project[key] : [];
  let visualCursor = 0;
  const summaries = clips.map((clip, index) => {
    const summary = clipSummary(track, clip, index, visualCursor);
    if (track === "visuals") visualCursor = summary.end;
    return summary;
  }).sort((left, right) => left.start - right.start || left.index - right.index);
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: commandState(project).revision,
    track,
    visible: project?.trackVisibility?.[TRACK_STATE_KEYS[track]] ?? true,
    locked: project?.trackLocks?.[TRACK_STATE_KEYS[track]] ?? false,
    clipCount: summaries.length,
    duration: summaries.reduce((maximum, clip) => Math.max(maximum, clip.end), 0),
    clips: summaries,
  };
}

export function inspectClip(project, clipId) {
  const { track, clip: storedClip, index } = findClipMatch(project, clipId);
  const clip = track === "captions" ? resolveProjectCaptions(project)[index] : storedClip;
  const visualStart = track === "visuals"
    ? project.visualSegments.slice(0, index).reduce((total, item) => total + Math.max(0, Number(item.duration) || 0), 0)
    : 0;
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: commandState(project).revision,
    track,
    summary: clipSummary(track, clip, index, visualStart),
    source: {
      assetId: clip.assetId || "",
      archiveMediaId: clip.archiveMediaId || clip.id,
      sourceStart: Math.max(0, Number(clip.sourceStart) || 0),
      sourceDuration: Math.max(0, Number(clip.sourceDuration) || 0),
      playbackRate: visualPlaybackRate(clip),
    },
    links: { audioSegmentId: clip.audioSegmentId || "", detachedAudioSegmentId: clip.detachedAudioSegmentId || "" },
    properties: Object.fromEntries(Object.entries(clip).filter(([key]) => !["id", "assetId", "archiveMediaId", "sourceStart", "sourceDuration", "playbackRate", "audioSegmentId", "detachedAudioSegmentId"].includes(key))),
  };
}

export function inspectTranscript(project, audioClipId = "") {
  const captions = resolveProjectCaptions(project)
    .map((caption, index) => {
      const start = Math.max(0, Number(caption.start) || 0);
      const end = Math.max(start, Number(caption.end) || start);
      const words = (Array.isArray(caption.words) ? caption.words : []).map((word) => ({
        text: String(word?.text ?? word?.word ?? ""),
        start: Math.max(start, Number(word?.start) || start),
        end: Math.max(start, Number(word?.end) || Number(word?.start) || start),
        ...(Number.isFinite(Number(word?.confidence)) ? { confidence: Number(word.confidence) } : {}),
      }));
      return {
        id: caption.id,
        index,
        text: caption.text || "",
        start,
        end,
        duration: end - start,
        speaker: caption.speaker || caption.speakerId || "",
        audioClipId: caption.audioSegmentId || "",
        detachedAudioClipId: caption.detachedAudioSegmentId || "",
        words,
      };
    }).filter((caption) => !audioClipId || (caption.audioClipId || caption.detachedAudioClipId) === audioClipId)
    .sort((left, right) => left.start - right.start || left.index - right.index);
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: commandState(project).revision,
    audioClipId,
    segmentCount: captions.length,
    wordCount: captions.reduce((total, caption) => total + caption.words.length, 0),
    duration: captions.reduce((maximum, caption) => Math.max(maximum, caption.end), 0),
    text: captions.map((caption) => caption.text).join("\n"),
    segments: captions,
  };
}

export function inspectMarkers(project, markerId = "") {
  const entries = markerEntries(project).sort((left, right) => left.marker.time - right.marker.time || left.index - right.index);
  const markers = entries.filter(({ marker }) => markerId === "" || marker.id === markerId).map(({ marker }) => marker);
  if (markerId !== "" && !markers.length) throw Object.assign(new Error(`Marker not found: ${markerId}`), { code: "MARKER_NOT_FOUND" });
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: commandState(project).revision,
    markerCount: markers.length,
    markers,
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diffProjects(beforeProject, afterProject) {
  const projectFields = ["ratioId", "fitMode", "trackVisibility", "trackLocks", "script", "captionsEnabled", "captionStyle", "captionSize", "captionStylePresetId", "captionStylePresets", "captionPlacement", "captionPosition", "sourceAudioVolume", "sourceAudioSpatialEffect", "sourceAudioSpatialAmount"]
    .flatMap((field) => sameValue(beforeProject?.[field], afterProject?.[field]) ? [] : [{ field, before: beforeProject?.[field] ?? null, after: afterProject?.[field] ?? null }]);
  const tracks = Object.fromEntries(Object.entries(TRACK_COLLECTIONS).flatMap(([track, key]) => {
    const before = Array.isArray(beforeProject?.[key]) ? beforeProject[key] : [];
    const after = Array.isArray(afterProject?.[key]) ? afterProject[key] : [];
    const beforeById = new Map(before.map((clip) => [clip.id, clip]));
    const afterById = new Map(after.map((clip) => [clip.id, clip]));
    const added = after.filter((clip) => !beforeById.has(clip.id)).map((clip) => clip.id);
    const removed = before.filter((clip) => !afterById.has(clip.id)).map((clip) => clip.id);
    const modified = after.flatMap((clip) => {
      const previous = beforeById.get(clip.id);
      if (!previous || sameValue(previous, clip)) return [];
      const fields = [...new Set([...Object.keys(previous), ...Object.keys(clip)])]
        .filter((field) => !sameValue(previous[field], clip[field]));
      return [{ id: clip.id, fields, before: Object.fromEntries(fields.map((field) => [field, previous[field] ?? null])), after: Object.fromEntries(fields.map((field) => [field, clip[field] ?? null])) }];
    });
    const orderBefore = before.map((clip) => clip.id);
    const orderAfter = after.map((clip) => clip.id);
    if (!added.length && !removed.length && !modified.length && sameValue(orderBefore, orderAfter)) return [];
    return [[track, { added, removed, modified, ...(sameValue(orderBefore, orderAfter) ? {} : { orderBefore, orderAfter }) }]];
  }));
  const beforeMarkers = inspectMarkers(beforeProject).markers;
  const afterMarkers = inspectMarkers(afterProject).markers;
  const beforeMarkersById = new Map(beforeMarkers.map((marker) => [marker.id, marker]));
  const afterMarkersById = new Map(afterMarkers.map((marker) => [marker.id, marker]));
  const markers = {
    added: afterMarkers.filter((marker) => !beforeMarkersById.has(marker.id)),
    removed: beforeMarkers.filter((marker) => !afterMarkersById.has(marker.id)),
    modified: afterMarkers.flatMap((marker) => {
      const previous = beforeMarkersById.get(marker.id);
      if (!previous || sameValue(previous, marker)) return [];
      const fields = [...new Set([...Object.keys(previous), ...Object.keys(marker)])]
        .filter((field) => !sameValue(previous[field], marker[field]));
      return [{ id: marker.id, fields, before: previous, after: marker }];
    }),
  };
  return { projectFields, tracks, ...(markers.added.length || markers.removed.length || markers.modified.length ? { markers } : {}) };
}

export function applyCommandPlan(project, plan) {
  const validity = validateCommandPlan(plan);
  if (!validity.ok) return validity;
  const current = commandState(project);
  const alreadyApplied = new Set(current.appliedOperationIds);
  if (plan.operations.every((operation) => alreadyApplied.has(operation.id))) {
    return {
      ok: true,
      revision: current.revision,
      appliedOperationIds: [],
      warnings: [],
      project: structuredClone(project),
      before: inspectProject(project),
      after: inspectProject(project),
      changes: { projectFields: [], tracks: {} },
    };
  }
  if (plan.baseRevision !== current.revision) {
    return failure("REVISION_CONFLICT", `Expected revision ${plan.baseRevision}, found ${current.revision}`);
  }
  const next = structuredClone(project);
  const appliedOperationIds = [];
  const warnings = [];
  let operationId = "";
  try {
    // Resolve imported/missing/duplicate IDs once before any marker mutations.
    // Deleting an earlier entry must not reassign a later annotation's identity.
    if (plan.operations.some((operation) => !alreadyApplied.has(operation.id) && operation.type.startsWith("marker."))) {
      next.timelineMarkers = normalizeTimelineMarkers(next.timelineMarkers);
    }
    for (const operation of plan.operations) {
      if (alreadyApplied.has(operation.id)) continue;
      operationId = operation.id;
      const outcome = reducers[operation.type](next, operation);
      if (outcome?.warnings) warnings.push(...outcome.warnings);
      appliedOperationIds.push(operation.id);
    }
  } catch (error) {
    return failure(error?.code || "OPERATION_FAILED", error instanceof Error ? error.message : "Operation failed", operationId);
  }
  const revision = appliedOperationIds.length ? current.revision + 1 : current.revision;
  next[COMMAND_STATE_KEY] = {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision,
    appliedOperationIds: [...current.appliedOperationIds, ...appliedOperationIds],
  };
  return {
    ok: true,
    revision,
    appliedOperationIds,
    warnings,
    project: next,
    before: inspectProject(project),
    after: inspectProject(next),
    changes: diffProjects(project, next),
  };
}
