import { applyCommandPlan, diffProjects, inspectProject, materializeProjectCaptionTimings } from "./projectCommandEngine.js";
import { applyTimelineRipple } from "./timelineRipple.js";
import { MAX_TIMELINE_DURATION_SECONDS, MIN_VISUAL_SEGMENT_SECONDS, STICKER_LIBRARY } from "../config/editor.js";
import { createCaptionSegments, getTimedSegmentLaneStateKey, isTimedSegmentLaneLocked } from "./timeline.js";
import { getLinkedSourceAudioSegments } from "./sourceAudioSync.js";
import { buildVectorDesignPatch } from "./vectorDesign.js";
import { getVisualSourceTime } from "./visualEffects.js";
import { getVisualSpeedCurveTimelineProgress } from "./visualSpeedCurve.js";
import { validateMiganRegions } from "./miganRepairRegions.js";
import { getDepthAnalysisSignature, validateDepthAnalysis } from "./depthOfField.js";
import { trimVisualSegmentState } from "./timelineCutActions.js";
import { normalizeSmartFrame } from "./smartFrame.js";

const TIME_EPSILON = 0.000001;
const MEDIA_FIELDS = ["blob", "src", "url", "originalSrc", "thumbnail", "originalBlob", "originalPeaks", "compatibilityAudioBlob", "voiceColorOriginalBlob", "peaks", "trackFrames", "trackFrameDuration", "trackFrameSampling", "trackFrameImportBudget", "cutoutVisual", "enhancement", "repair", "assetId", "archiveMediaId", "integrity"];
const RIPPLE_ARRAY_FIELDS = ["audioSegments", "captionSegments", "visualOverlaySegments", "stickerSegments", "musicSegments"];
const RIPPLE_FIELDS = [...RIPPLE_ARRAY_FIELDS, "musicStart", "sourceAudioStart"];
const runtimeIdentities = new WeakMap();
let nextRuntimeIdentity = 0;

export const BROWSER_EDIT_TRIM_RULES = Object.freeze({
  sourceTimeUnit: "seconds",
  sourceTimeOrigin: "absolute source-media time",
  minimumDuration: MIN_VISUAL_SEGMENT_SECONDS,
  completeClipOrderRequired: true,
  description: "Reorder existing main-visual clips, or shorten videos within their current source range. Constant speed, speed curves and ordinary transform keyframes are retained; reverse, legacy property keyframes, transitions, subject effects and processed media remain unsupported.",
});

function reject(code) {
  throw Object.assign(new Error(code), { code });
}

// The fingerprint includes UI edits and undo, which do not increment the CLI revision.
function runtimeIdentity(value) {
  if (value === null || typeof value !== "object") return value ?? null;
  if (!runtimeIdentities.has(value)) runtimeIdentities.set(value, ++nextRuntimeIdentity);
  return runtimeIdentities.get(value);
}

export function browserProjectFingerprint(project, rippleEditing, visualSegments, runtimeProject) {
  // Decoded filmstrips are a display cache, not an edit. Refinement may finish
  // after apply or seek; it must neither invalidate a review nor consume undo.
  const withoutFilmstrip = ({ trackFrames: _frames, trackFrameDuration: _duration, trackFrameSampling: _sampling, trackFrameImportBudget: _budget, ...clip }) => clip;
  const { timelineZoom: _zoom, ...projectContent } = project;
  const semanticProject = {
    ...projectContent,
    visualSegments: project.visualSegments?.map(withoutFilmstrip),
    visualOverlaySegments: project.visualOverlaySegments?.map(withoutFilmstrip),
  };
  const runtimeVisuals = visualSegments?.map((clip) => ({
    id: clip.id,
    assetId: clip.assetId,
    archiveMediaId: clip.archiveMediaId,
    src: clip.src,
    blob: runtimeIdentity(clip.blob),
    cutoutVisual: runtimeIdentity(clip.cutoutVisual),
    enhancement: runtimeIdentity(clip.enhancement),
    repair: runtimeIdentity(clip.repair),
    vision: clip.vision ? { kind: clip.vision.kind, complete: clip.vision.complete,
      cutoutAssetId: clip.vision.cutoutAssetId, cutoutUrl: clip.vision.cutoutUrl,
      removeBackground: clip.vision.options?.removeBackground, avoidCaptions: clip.vision.options?.avoidCaptions } : null,
    trimAllowed: supportsBrowserTrim(clip),
  }));
  const runtimeMedia = runtimeProject ? {
    tracks: Object.fromEntries(["audioSegments", "visualOverlaySegments", "musicSegments"].map((key) => [key,
      (runtimeProject[key] || []).map((clip) => ({ id: clip.id, blob: runtimeIdentity(clip.blob), src: clip.src, url: clip.url,
        originalBlob: runtimeIdentity(clip.originalBlob), voiceColorOriginalBlob: runtimeIdentity(clip.voiceColorOriginalBlob), cutoutVisual: runtimeIdentity(clip.cutoutVisual), enhancement: runtimeIdentity(clip.enhancement), repair: runtimeIdentity(clip.repair),
        vision: clip.vision ? { kind: clip.vision.kind, complete: clip.vision.complete,
          cutoutAssetId: clip.vision.cutoutAssetId, cutoutUrl: clip.vision.cutoutUrl,
          removeBackground: clip.vision.options?.removeBackground, avoidCaptions: clip.vision.options?.avoidCaptions } : null }))])),
    musicBlob: runtimeIdentity(runtimeProject.musicBlob), sourceAudioBlob: runtimeIdentity(runtimeProject.sourceAudioBlob),
    sourceVoiceColorOriginal: runtimeIdentity(runtimeProject.sourceVoiceColorOriginal),
  } : undefined;
  return JSON.stringify({ ...semanticProject, rippleEditing, runtimeVisuals, runtimeMedia });
}

export function getBrowserPlanningClips(visualSegments = []) {
  return visualSegments.map((clip, index) => ({
    clipId: clip.id,
    type: clip.type === "video" ? "video" : "image",
    name: String(clip.name || clip.id),
    duration: Number(clip.duration),
    sourceIn: Number(clip.sourceStart) || 0,
    sourceOut: (Number(clip.sourceStart) || 0) + (Number(clip.sourceDuration) || Number(clip.duration)),
    trimAllowed: clip.type === "video" && supportsBrowserSourceRangeEdit(clip) && !hasTransition(visualSegments[index - 1]),
    splitAllowed: supportsBrowserSourceRangeEdit(clip) && !hasTransition(visualSegments[index - 1])
      && Number(clip.duration) >= MIN_VISUAL_SEGMENT_SECONDS * 2,
  }));
}

function hasTransition(clip) {
  return Boolean(clip?.transition?.id && clip.transition.id !== "none");
}

export function supportsBrowserTrim(clip) {
  const rate = clip?.playbackRate === undefined ? 1 : Number(clip.playbackRate);
  return (
    clip?.type === "video" &&
    !clip.preparing &&
    rate === 1 &&
    !clip.speedCurve?.enabled &&
    !clip.reversed &&
    !clip.reverse &&
    !clip.keyframes?.length &&
    !Object.values(clip.propertyKeyframes || {}).some((frames) => frames?.length) &&
    ![clip.animation?.in, clip.animation?.out].some((phase) => phase?.id && phase.id !== "none") &&
    !clip.effects?.length &&
    !clip.clickRipple?.enabled &&
    !clip.cinematicDepth?.enabled &&
    !clip.photoParallax?.enabled &&
    !clip.smartFrame?.enabled &&
    !clip.subjectEffect?.enabled &&
    !clip.vision &&
    !hasTransition(clip) &&
    !clip.cutoutVisual &&
    !clip.enhancement
  );
}

function supportsBrowserSourceRangeEdit(clip) {
  if (!clip || !["image", "video"].includes(clip.type) || clip.reversed || clip.reverse
    || Object.values(clip.propertyKeyframes || {}).some(frames => frames?.length)) return false;
  return supportsBrowserTrim({ ...clip, type: "video", playbackRate: 1, speedCurve: undefined, keyframes: [] });
}

function indexedSegments(segments) {
  if (!Array.isArray(segments)) reject("BROWSER_EDIT_INVALID_PLAN");
  const index = new Map();
  for (const clip of segments) {
    if (!clip || typeof clip.id !== "string" || !clip.id || index.has(clip.id)) reject("BROWSER_EDIT_INVALID_PLAN");
    index.set(clip.id, clip);
  }
  return index;
}

function completeBrowserProject(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) reject("BROWSER_EDIT_INVALID_PLAN");
  const next = { ...project };
  for (const key of ["visualSegments", ...RIPPLE_ARRAY_FIELDS]) {
    // Older/partial snapshots can omit empty tracks. A present malformed value
    // is rejected rather than silently dropping an existing track's contents.
    if (next[key] == null) next[key] = [];
    else if (!Array.isArray(next[key])) reject("BROWSER_EDIT_INVALID_PLAN");
  }
  for (const key of ["musicStart", "sourceAudioStart"]) {
    if (next[key] == null) next[key] = 0;
    if (typeof next[key] !== "number" || !Number.isFinite(next[key]) || next[key] < 0) reject("BROWSER_EDIT_INVALID_PLAN");
  }
  return next;
}

function browserCaptionBaseline(project) {
  try {
    return materializeProjectCaptionTimings(project);
  } catch {
    reject("BROWSER_EDIT_INVALID_PLAN");
  }
}

function assertLockedSourceUnchanged(project, next, options) {
  if (!project.trackLocks?.source || !options.hasSourceAudio || project.sourceAudioLinked === false) return;
  const beforeSource = getLinkedSourceAudioSegments(project.visualSegments, project.sourceAudioAssetId, project.sourceAudioDuration);
  const afterSource = getLinkedSourceAudioSegments(next.visualSegments, next.sourceAudioAssetId, next.sourceAudioDuration);
  if (JSON.stringify(beforeSource) !== JSON.stringify(afterSource)) reject("BROWSER_EDIT_TRACK_LOCKED");
}

/**
 * Compile a complete clip ordering and optional absolute source trim ranges into
 * the shared command engine. This is a pure review: callers must compare the
 * fingerprint again and commit the reviewed project as one undoable transaction.
 */
export function buildBrowserTimelineReview(inputProject, response, options = {}) {
  const project = browserCaptionBaseline(completeBrowserProject(inputProject));
  const originals = project.visualSegments;
  const sourceById = indexedSegments(originals);
  const requested = response?.clips;
  if (!originals.length || !Array.isArray(requested) || requested.length !== originals.length)
    reject("BROWSER_EDIT_INVALID_PLAN");
  if (project.trackLocks?.image) reject("BROWSER_EDIT_TRACK_LOCKED");
  const beforeDuration = originals.reduce((sum, clip) => {
    if (typeof clip.duration !== "number" || !Number.isFinite(clip.duration) || clip.duration < MIN_VISUAL_SEGMENT_SECONDS) reject("BROWSER_EDIT_INVALID_PLAN");
    return sum + clip.duration;
  }, 0);
  if (beforeDuration > MAX_TIMELINE_DURATION_SECONDS) reject("BROWSER_EDIT_INVALID_PLAN");
  // Archive snapshots omit processed-media fields. Only the corresponding live
  // clips can establish whether a trim is safe; absent context permits reorder only.
  const runtimeById = options.visualSegments ? indexedSegments(options.visualSegments) : null;
  if (runtimeById && (runtimeById.size !== sourceById.size || originals.some((clip) => !runtimeById.has(clip.id)))) reject("BROWSER_EDIT_STALE_PLAN");
  if (runtimeById && originals.some((clip) => ["type", "duration", "sourceStart", "sourceDuration", "playbackRate", "sourceAudioOffset"]
    .some((key) => !Object.is(clip[key], runtimeById.get(clip.id)[key])))) reject("BROWSER_EDIT_STALE_PLAN");
  const seen = new Set();
  const operations = [];
  const orderedIds = originals.map((clip) => clip.id);
  const baseRevision = project.commandState?.revision || 0;
  const batch = crypto.randomUUID();
  const add = (operation) => operations.push({ ...operation, id: `${batch}-${operations.length}` });
  requested.forEach((item, index) => {
    if (!item || typeof item.clipId !== "string") reject("BROWSER_EDIT_INVALID_PLAN");
    const clip = sourceById.get(item.clipId);
    if (!clip || seen.has(item.clipId)) reject("BROWSER_EDIT_INVALID_PLAN");
    seen.add(item.clipId);
    const originalSourceStart = clip.sourceStart === undefined ? 0 : Number(clip.sourceStart);
    const originalSourceDuration = clip.sourceDuration === undefined ? Number(clip.duration) : Number(clip.sourceDuration);
    const sourceIn = item.sourceIn === undefined ? originalSourceStart : item.sourceIn;
    const sourceOut = item.sourceOut === undefined ? originalSourceStart + originalSourceDuration : item.sourceOut;
    const rangeRequested = item.sourceIn !== undefined || item.sourceOut !== undefined;
    const rangeChanged = rangeRequested && (Math.abs(sourceIn - originalSourceStart) > TIME_EPSILON
      || Math.abs(sourceOut - (originalSourceStart + originalSourceDuration)) > TIME_EPSILON);
    // A reordered complex clip is preserved byte-for-byte. Source times only
    // become editable when a real trim is requested and the safe trim gate passes.
    const offset = rangeChanged ? sourceIn - originalSourceStart : 0;
    const duration = rangeChanged ? sourceOut - sourceIn : clip.duration;
    if (rangeRequested && (typeof sourceIn !== "number" || !Number.isFinite(sourceIn)
      || typeof sourceOut !== "number" || !Number.isFinite(sourceOut))) reject("BROWSER_EDIT_INVALID_PLAN");
    if (
      typeof offset !== "number" ||
      !Number.isFinite(offset) ||
      offset < 0 ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < MIN_VISUAL_SEGMENT_SECONDS ||
      offset + duration > clip.duration + TIME_EPSILON
    )
      reject("BROWSER_EDIT_INVALID_PLAN");
    // Only compile effective moves. A model may return the current sequence;
    // that is a reviewable no-op, not a successful edit or a new revision.
    const fromIndex = orderedIds.indexOf(clip.id);
    if (fromIndex !== index) {
      add({ type: "visual.reorder", clipId: clip.id, toIndex: index });
      orderedIds.splice(fromIndex, 1);
      orderedIds.splice(index, 0, clip.id);
    }
    const changed = offset > TIME_EPSILON || Math.abs(duration - clip.duration) > TIME_EPSILON;
    if (changed) {
      if (clip.type !== "video") reject("BROWSER_EDIT_INVALID_PLAN");
      const runtimeClip = runtimeById?.get(clip.id);
      const originalIndex = originals.findIndex((value) => value.id === clip.id);
      const previousClip = index > 0 ? sourceById.get(requested[index - 1]?.clipId) : null;
      if (!supportsBrowserTrim(clip) || !supportsBrowserTrim(runtimeClip) || hasTransition(originals[originalIndex - 1]) || hasTransition(previousClip)) reject("BROWSER_EDIT_COMPLEX_TIMING");
      const sourceStart = clip.sourceStart === undefined ? 0 : Number(clip.sourceStart);
      const sourceDuration = clip.sourceDuration === undefined ? clip.duration : Number(clip.sourceDuration);
      if (!Number.isFinite(sourceStart) || sourceStart < 0 || !Number.isFinite(sourceDuration) || sourceDuration <= 0) reject("BROWSER_EDIT_INVALID_PLAN");
      const sourceIn = sourceStart + offset;
      const sourceOut = Math.min(sourceStart + sourceDuration, sourceStart + clip.duration, sourceIn + duration);
      // Tolerate rounding at a boundary, never silently shorten a requested trim
      // to fit a missing or inconsistent source range.
      if (Math.abs((sourceOut - sourceIn) - duration) > TIME_EPSILON || sourceOut - sourceIn < MIN_VISUAL_SEGMENT_SECONDS - TIME_EPSILON) reject("BROWSER_EDIT_INVALID_PLAN");
      add({ type: "visual.trim", clipId: clip.id, sourceIn, sourceOut });
    }
  });
  const result = operations.length
    ? applyCommandPlan(project, { schemaVersion: 1, baseRevision, operations })
    : { ok: true, project: structuredClone(project) };
  if (!result.ok) reject("BROWSER_EDIT_INVALID_PLAN");

  // Apply each duration change to one accumulating snapshot, avoiding stale React setters.
  const next = { ...result.project };
  assertLockedSourceUnchanged(project, next, options);
  const originalLocks = project.trackLocks || {};
  const lockedAudioIds = new Set((project.audioSegments || [])
    .filter((clip) => isTimedSegmentLaneLocked(project.audioSegments, clip.id, originalLocks))
    .map((clip) => clip.id));
  if (originalLocks.caption) {
    for (const caption of project.captionSegments || []) {
      if (caption.audioSegmentId) lockedAudioIds.add(caption.audioSegmentId);
    }
  }
  const ripple = {
    ...project,
    // Resolve audio-lane locks once for this atomic edit. Repacking after one
    // trim must not make a formerly locked clip movable during the next trim.
    trackLocks: Object.fromEntries(Object.entries(originalLocks).filter(([key]) => !/^audio-\d+$/.test(key))),
    rippleEditing: options.rippleEditing,
    musicBlob: options.hasMusic,
    sourceAudioBlob: options.hasSourceAudio,
  };
  for (const key of RIPPLE_FIELDS) {
    ripple[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => {
      ripple[key] = typeof value === "function" ? value(ripple[key]) : value;
    };
  }
  let boundary = 0;
  let previousStart = 0;
  const rows = next.visualSegments.map((clip, index) => {
    const before = sourceById.get(clip.id);
    const beforeIndex = originals.findIndex((item) => item.id === clip.id);
    const beforeStart = originals
      .slice(0, beforeIndex)
      .reduce((sum, item) => sum + Number(item.duration), 0);
    boundary += Number(before.duration);
    const delta = Number(clip.duration) - Number(before.duration);
    if (delta) {
      const previousAudio = new Map((ripple.audioSegments || []).map((item) => [item.id, item]));
      const previousCaptions = new Map((ripple.captionSegments || []).map((item) => [item.id, item]));
      applyTimelineRipple(ripple, boundary, delta);
      ripple.audioSegments = ripple.audioSegments.map((item) => lockedAudioIds.has(item.id) ? previousAudio.get(item.id) : item);
      ripple.captionSegments = ripple.captionSegments.map((item) => lockedAudioIds.has(item.audioSegmentId) ? previousCaptions.get(item.id) : item);
    }
    boundary += delta;
    const row = {
      id: clip.id,
      name: clip.name || clip.id,
      index,
      beforeIndex,
      beforeStart,
      start: previousStart,
      beforeDuration: Number(before.duration),
      duration: Number(clip.duration),
      beforeSourceStart: Number(before.sourceStart) || 0,
      sourceStart: Number(clip.sourceStart) || 0,
      reordered: beforeIndex !== index,
      trimmed: Math.abs(delta) > TIME_EPSILON ||
        Math.abs((Number(before.sourceStart) || 0) - (Number(clip.sourceStart) || 0)) > TIME_EPSILON,
      changed:
        beforeIndex !== index ||
        Math.abs(delta) > TIME_EPSILON ||
        Math.abs((Number(before.sourceStart) || 0) - (Number(clip.sourceStart) || 0)) > TIME_EPSILON,
    };
    previousStart += Number(clip.duration);
    return row;
  });
  for (const key of RIPPLE_FIELDS)
    next[key] = ripple[key];
  for (const id of lockedAudioIds) {
    if ((project.audioSegments || []).some((item) => item.id === id) &&
      getTimedSegmentLaneStateKey(project.audioSegments, id) !== getTimedSegmentLaneStateKey(next.audioSegments, id)) reject("BROWSER_EDIT_TRACK_LOCKED");
  }
  const changes = diffProjects(project, next);
  for (const field of ["musicStart", "sourceAudioStart"]) {
    if (project[field] !== next[field]) changes.projectFields.push({ field, before: project[field], after: next[field] });
  }
  return {
    operations,
    diff: changes,
    title: typeof response.title === "string" ? response.title : "",
    summary: typeof response.summary === "string" ? response.summary : "",
    model: typeof response.model === "string" ? response.model : "",
    fingerprint: browserProjectFingerprint(inputProject, options.rippleEditing, options.visualSegments, options.runtimeProject),
    project: completeBrowserProject(next),
    beforeProject: project,
    rows,
    hasChanges: rows.some((row) => row.changed),
    changeSummary: {
      reordered: rows.filter((row) => row.reordered).length,
      trimmed: rows.filter((row) => row.trimmed).length,
    },
    changes,
    beforeDuration,
    duration: previousStart,
  };
}

const MEDIA_COLLECTIONS = ["visualSegments", "visualOverlaySegments", "audioSegments", "musicSegments", "stickerSegments"];
const CLIP_COLLECTIONS = [...MEDIA_COLLECTIONS, "captionSegments"];
const MEDIA_REPLACEMENT_ORIGINS = new Set(["voice-color", "audio-reverse", "audio-replacement"]);

export const BROWSER_OPERATION_FIELDS = Object.freeze({
  "voice.restore_history": ["historyId", "clipId", "start"],
  "voice.remove_history": ["historyId"],
  "track.clear_music": [],
  "track.clear_source_audio": [],
  "source.replace_audio": ["assetId"],
  "track.replace_music": ["assetId", "clipId", "start", "duration"],
  "asset.remove_from_library": ["assetId"],
  "caption.add": ["clipId", "text", "start", "end", "audioClipId", "visualClipId"],
  "caption.update": ["clipId", "text", "start", "end", "hidden"],
  "caption.delete": ["clipId"],
  "caption.import_srt": ["text", "mode"],
  "caption.set_enabled": ["enabled"],
  "caption.set_style": ["scope", "clipId", "style"],
  "caption.apply_preset": ["scope", "clipId", "presetId"],
  "caption.save_preset": ["scope", "clipId", "name"],
  "caption.set_position": ["scope", "clipId", "placement"],
  "caption.sync_position": ["clipId"],
  "caption.reset_overrides": ["clipId", "property"],
  "caption.unlink_audio": ["clipId"],
  "caption.link_audio": ["clipId", "audioClipId", "align"],
  "transition.set": ["clipId", "transitionId", "duration"],
  "track.set_visibility": ["track", "visible", "clipId"],
  "track.set_locked": ["track", "locked", "clipId"],
  "track.set_source_audio": ["settings"],
  "source.set_volume": ["clipId", "volume"],
  "timed.move": ["track", "clipId", "start", "layer"],
  "timed.resize": ["track", "clipId", "start", "duration"],
  "timed.trim": ["track", "clipId", "sourceIn", "sourceOut"],
  "clip.delete": ["track", "clipId"],
  "overlay.set_transform": ["clipId", "transform"],
  "visual.set_transform": ["clipId", "transform"],
  "sticker.set_transform": ["clipId", "transform"],
  "clip.set_vector_design": ["clipId", "design"],
  "clip.set_vector_part": ["clipId", "partId", "patch"],
  "sticker.add": ["clipId", "stickerId", "start", "duration", "transform"],
  "caption.split": ["clipId", "rightClipId", "at"],
  "caption.duplicate": ["clipId", "newClipId"],
  "timed.split": ["track", "clipId", "rightClipId", "at"],
  "timed.duplicate": ["track", "clipId", "newClipId", "start", "captionCopies"],
  "project.set_ratio": ["ratio"],
  "project.set_fit": ["fitMode"],
  "clip.set_property": ["clipId", "property", "value"],
  "clip.set_speed": ["clipId", "speed"],
  "clip.set_speed_curve": ["clipId", "curve"],
  "clip.set_enhancement_enabled": ["clipId", "enabled"],
  "clip.set_repair_enabled": ["clipId", "enabled"],
  "clip.apply_repair": ["clipId", "assetId", "regions"],
  "clip.apply_vision_cutout": ["clipId", "sourceAssetId", "assetId"],
  "clip.set_subject_background_media": ["clipId", "assetId", "fitMode", "opacity"],
  "clip.apply_caption_avoidance": ["clipId", "sourceAssetId", "analysis"],
  "clip.set_caption_avoidance": ["clipId", "enabled"],
  "clip.apply_smart_frame": ["clipId", "sourceAssetId", "smartFrame"],
  "clip.remove_smart_frame": ["clipId"],
  "clip.apply_depth_analysis": ["clipId", "sourceAssetId", "analysis"],
  "clip.apply_enhancement": ["clipId", "assetId", "mode", "processing"],
  "audio.apply_voice_color": ["clipId", "assetId", "profileName"],
  "audio.apply_reverse": ["clipId", "assetId", "reversed"],
  "audio.replace_source": ["clipId", "assetId"],
  "audio.restore_voice_color": ["clipId"],
  "source.apply_voice_color": ["assetId", "profileName"],
  "source.restore_voice_color": [],
  "clip.set_muted": ["clipId", "muted"],
  "clip.set_spatial": ["clipId", "effect", "amount"],
  "clip.keyframe_set": ["clipId", "time", "property", "value"],
  "clip.keyframe_remove": ["clipId", "time", "property"],
  "clip.set_filter": ["clipId", "filterId"],
  "clip.set_animation": ["clipId", "phase", "animationId", "duration"],
  "clip.set_color_grade": ["clipId", "property", "value"],
  "clip.set_mask": ["clipId", "mask"],
  "clip.set_subject_effect": ["clipId", "property", "value"],
  "clip.set_click_ripple": ["clipId", "property", "value"],
  "clip.set_cinematic_depth": ["clipId", "property", "value"],
  "clip.set_photo_parallax": ["clipId", "property", "value"],
  "marker.add": ["markerId", "markerType", "time", "endTime", "title", "notes", "color"],
  "marker.update": ["markerId", "markerType", "time", "endTime", "title", "notes", "color"],
  "marker.delete": ["markerId"],
  "visual.reorder": ["clipId", "toIndex"],
  "visual.trim": ["clipId", "sourceIn", "sourceOut"],
  "visual.split": ["clipId", "at", "rightClipId"],
  "visual.delete": ["clipId"],
  "visual.duplicate": ["clipId", "newClipId", "atIndex"],
  "visual.insert": ["clipId", "sourceClipId", "assetId", "atIndex", "duration"],
  "overlay.add": ["clipId", "sourceClipId", "assetId", "start", "duration", "layer", "muted", "transform"],
  "asset.insert": ["clipId", "assetId", "track", "atIndex", "start", "duration", "layer", "muted", "transform"],
});

function assertId(id) {
  if (typeof id !== "string" || !id || id !== id.trim() || id.length > 256) reject("BROWSER_EDIT_INVALID_PLAN");
}

function validTime(value, minimum = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > MAX_TIMELINE_DURATION_SECONDS) reject("BROWSER_EDIT_INVALID_PLAN");
  return value;
}

function validSourceTime(value, minimum = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > Number.MAX_SAFE_INTEGER) reject("BROWSER_EDIT_INVALID_PLAN");
  return value;
}

function normalizeCaptionSubject(subject) {
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return null;
  const raw = subject.box;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const box = Object.fromEntries([["xmin", "xmin", "xMin"], ["ymin", "ymin", "yMin"], ["xmax", "xmax", "xMax"], ["ymax", "ymax", "yMax"]]
    .map(([target, lower, upper]) => [target, Number(raw[lower] ?? raw[upper])]));
  if (!Object.values(box).every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    || box.xmax <= box.xmin || box.ymax <= box.ymin) return null;
  const score = Number(subject.score);
  if (subject.score !== undefined && (!Number.isFinite(score) || score < 0 || score > 1)) return null;
  return { label: String(subject.label || "subject").slice(0, 256), ...(subject.score === undefined ? {} : { score }), box };
}

function prepareCaptionAvoidanceAnalysis(analysis, clip, assetId) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis) || analysis.complete !== true
    || analysis.visualType !== clip.type || !["image-subject", "video-timeline"].includes(analysis.kind)) reject("BROWSER_EDIT_INVALID_PLAN");
  const signature = analysis.sourceSignature;
  const sourceStart = Math.max(0, Number(clip.sourceStart) || 0);
  const sourceDuration = Math.max(0, Number(clip.sourceDuration) || Number(clip.duration) || 0);
  const playbackRate = Math.max(0.25, Math.min(4, Number(clip.playbackRate) || 1));
  if (!signature || signature.assetId !== assetId || Math.abs(Number(signature.sourceStart) - sourceStart) > TIME_EPSILON
    || Math.abs(Number(signature.sourceDuration) - sourceDuration) > TIME_EPSILON
    || Math.abs(Number(signature.playbackRate) - playbackRate) > TIME_EPSILON) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
  const sourceSize = { width: Number(analysis.sourceSize?.width), height: Number(analysis.sourceSize?.height) };
  if (!(sourceSize.width > 0) || !(sourceSize.height > 0)) reject("BROWSER_EDIT_INVALID_PLAN");
  const basis = {
    kind: analysis.kind, complete: true, visualType: clip.type, sourceSize,
    sourceSignature: { assetId, sourceStart, sourceDuration, playbackRate },
    modelId: String(analysis.modelId || "YOLOS-tiny"), modelRevision: String(analysis.modelRevision || ""),
    runtimeBackend: String(analysis.runtimeBackend || "unknown"), options: { avoidCaptions: true },
  };
  if (clip.type === "image") {
    const subject = normalizeCaptionSubject(analysis.subject);
    if (!subject || analysis.kind !== "image-subject") reject("BROWSER_EDIT_INVALID_PLAN");
    return { ...basis, subject, detections: [subject] };
  }
  if (analysis.kind !== "video-timeline" || !Array.isArray(analysis.samples)
    || analysis.samples.length < 2 || analysis.samples.length > 480) reject("BROWSER_EDIT_INVALID_PLAN");
  let previousTime = -Infinity, tracked = false;
  const samples = analysis.samples.map((sample) => {
    const time = Number(sample?.time), subject = sample?.subject == null ? null : normalizeCaptionSubject(sample.subject);
    if (!Number.isFinite(time) || time < sourceStart - TIME_EPSILON || time > sourceStart + sourceDuration + TIME_EPSILON
      || time < previousTime || sample?.subject != null && !subject) reject("BROWSER_EDIT_INVALID_PLAN");
    previousTime = time; tracked ||= Boolean(subject);
    return { time, subject, source: sample?.source === "detector" ? "detector" : "flow", state: subject ? "tracked" : "lost" };
  });
  if (!tracked) reject("BROWSER_EDIT_INVALID_PLAN");
  return { ...basis, duration: sourceStart + sourceDuration, samples };
}

function projectClipMap(project) {
  return indexedSegments(CLIP_COLLECTIONS.flatMap((key) => project[key] || []));
}

function findProjectClip(project, clipId) {
  for (const key of CLIP_COLLECTIONS) {
    const clip = (project[key] || []).find((item) => item.id === clipId);
    if (clip) return { key, clip };
  }
  reject("BROWSER_EDIT_INVALID_PLAN");
}

function assetMap(assets = []) {
  const entries = new Map();
  for (const asset of assets) {
    const id = asset?.assetId || asset?.id;
    assertId(id);
    if (entries.has(id)) reject("BROWSER_EDIT_INVALID_PLAN");
    entries.set(id, asset);
  }
  return entries;
}

function audioLaneMap(project) {
  return new Map((project.audioSegments || []).map((clip) => [clip.id, getTimedSegmentLaneStateKey(project.audioSegments, clip.id)]));
}

function assertClipUnlocked(project, clipId, originalLocks, originalAudioLanes) {
  const { key } = findProjectClip(project, clipId);
  const stateKey = { visualSegments: "image", visualOverlaySegments: "overlay", captionSegments: "caption", musicSegments: "music", stickerSegments: "sticker", audioSegments: "audio" }[key];
  if (originalLocks[stateKey] || (key === "audioSegments" && originalLocks[originalAudioLanes.get(clipId) || getTimedSegmentLaneStateKey(project.audioSegments, clipId)])) reject("BROWSER_EDIT_TRACK_LOCKED");
}

function validateBrowserOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) reject("BROWSER_EDIT_INVALID_PLAN");
  const fields = Object.hasOwn(BROWSER_OPERATION_FIELDS, operation.type) ? BROWSER_OPERATION_FIELDS[operation.type] : null;
  if (!fields || Object.keys(operation).some((field) => field !== "type" && !fields.includes(field))) reject("BROWSER_EDIT_INVALID_PLAN");
  for (const field of ["clipId", "sourceClipId", "newClipId", "rightClipId", "assetId", "sourceAssetId", "audioClipId", "markerId"]) {
    if (Object.hasOwn(operation, field)) assertId(operation[field]);
  }
  if (operation.type === "voice.remove_history") assertId(operation.historyId);
  else if (operation.type === "source.apply_voice_color") { assertId(operation.assetId); assertId(operation.profileName); }
  else if (operation.type === "source.replace_audio") assertId(operation.assetId);
  else if (operation.type === "source.restore_voice_color") { /* The standalone source track has no clip ID. */ }
  else if (operation.type === "asset.remove_from_library") assertId(operation.assetId);
  else if (operation.type.startsWith("marker.")) {
    assertId(operation.markerId);
    if (operation.markerId.length > 160) reject("BROWSER_EDIT_INVALID_PLAN");
  }
  else if (!operation.type.startsWith("project.") && !operation.type.startsWith("track.") && !["caption.import_srt", "caption.set_enabled"].includes(operation.type) && !(["caption.set_style", "caption.set_position", "caption.apply_preset", "caption.save_preset"].includes(operation.type) && operation.scope === "default")) assertId(operation.clipId);
  if (operation.type.startsWith("timed.") || operation.type === "clip.delete") {
    if (!["audio", "music", "overlays", "stickers"].includes(operation.track)) reject("BROWSER_EDIT_INVALID_PLAN");
    if (operation.type === "timed.trim" && operation.track === "stickers") reject("BROWSER_EDIT_INVALID_PLAN");
    if (Object.hasOwn(operation, "layer") && !["audio", "overlays"].includes(operation.track)) reject("BROWSER_EDIT_INVALID_PLAN");
  }
  if (Object.hasOwn(operation, "text") && (typeof operation.text !== "string" || operation.type !== "caption.import_srt" && operation.text.length > 20000)) reject("BROWSER_EDIT_INVALID_PLAN");
  if (Object.hasOwn(operation, "muted") && typeof operation.muted !== "boolean") reject("BROWSER_EDIT_INVALID_PLAN");
  if (Object.hasOwn(operation, "align") && typeof operation.align !== "boolean") reject("BROWSER_EDIT_INVALID_PLAN");
  if (Object.hasOwn(operation, "duration")) validTime(operation.duration, operation.type === "transition.set" ? Number.MIN_VALUE : MIN_VISUAL_SEGMENT_SECONDS);
  for (const field of ["start", "end", "at"]) if (Object.hasOwn(operation, field)) validTime(operation[field]);
  for (const field of ["sourceIn", "sourceOut"]) if (Object.hasOwn(operation, field)) validSourceTime(operation[field]);
  if (Object.hasOwn(operation, "layer") && (!Number.isInteger(operation.layer) || operation.layer < 1 || operation.layer > 1000)) reject("BROWSER_EDIT_INVALID_PLAN");
  if (Object.hasOwn(operation, "transform")) {
    const limits = { x: [-1000, 1000], y: [-1000, 1000], scale: [0.1, 20], rotation: [-36000, 36000], opacity: [0, 1] };
    if (!operation.transform || typeof operation.transform !== "object" || Array.isArray(operation.transform)) reject("BROWSER_EDIT_INVALID_PLAN");
    for (const [key, value] of Object.entries(operation.transform)) {
      if (!Object.hasOwn(limits, key) || typeof value !== "number" || !Number.isFinite(value) || value < limits[key][0] || value > limits[key][1]) reject("BROWSER_EDIT_INVALID_PLAN");
    }
  }
}

function assertPlainVisual(clip) {
  if (!clip || !["image", "video"].includes(clip.type) || !supportsBrowserTrim({ ...clip, type: "video" })) reject("BROWSER_EDIT_COMPLEX_TIMING");
}

function prepareAudioLaneEdit(project, operation, locks) {
  const priorLanes = audioLaneMap(project);
  for (const clip of project.audioSegments) clip.lane = Number(priorLanes.get(clip.id).slice(6));
  if (operation.type === "clip.delete") return;
  const clip = project.audioSegments.find((item) => item.id === operation.clipId);
  const start = operation.start ?? clip.start;
  const duration = operation.duration ?? clip.duration;
  let lane = operation.layer === undefined ? clip.lane : operation.layer - 1;
  const overlaps = (candidate) => project.audioSegments.some((item) => item.id !== clip.id && item.lane === candidate
    && item.start < start + duration - 0.001 && item.start + item.duration > start + 0.001);
  if (overlaps(lane)) {
    if (operation.layer !== undefined) reject("BROWSER_EDIT_INVALID_PLAN");
    lane = Math.max(-1, ...project.audioSegments.map((item) => item.lane)) + 1;
  }
  if (locks[`audio-${lane}`]) reject("BROWSER_EDIT_TRACK_LOCKED");
  if (operation.type === "timed.move") operation.layer = lane + 1;
  else clip.lane = lane;
}

function projectDuration(project, options) {
  const base = inspectProject(project).duration;
  const sourceDuration = options.hasSourceAudio
    ? project.sourceAudioLinked === false
      ? (Number(project.sourceAudioStart) || 0) + (Number(project.sourceAudioDuration) || 0)
      : getLinkedSourceAudioSegments(project.visualSegments, project.sourceAudioAssetId, project.sourceAudioDuration)
        .reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)
    : 0;
  const musicDuration = options.hasMusic && !(project.musicSegments || []).length
    ? (Number(project.musicStart) || 0) + (Number(project.musicDuration) || 0) : 0;
  return Math.max(base, sourceDuration, musicDuration);
}

function applyBrowserRipple(project, boundary, delta, options, originalAudioLanes, locks) {
  if (!options.rippleEditing || Math.abs(delta) < TIME_EPSILON) return;
  const fixedAudio = new Set((project.audioSegments || []).filter((clip) => locks.audio
    || locks[originalAudioLanes.get(clip.id) || getTimedSegmentLaneStateKey(project.audioSegments, clip.id)]).map((clip) => clip.id));
  if (locks.caption) for (const caption of project.captionSegments || []) if (caption.audioSegmentId) fixedAudio.add(caption.audioSegmentId);
  const beforeAudio = new Map(project.audioSegments.map((clip) => [clip.id, clip]));
  const beforeCaptions = new Map(project.captionSegments.map((clip) => [clip.id, clip]));
  const state = { ...project, trackLocks: Object.fromEntries(Object.entries(locks).filter(([key]) => !/^audio-\d+$/.test(key))),
    rippleEditing: true, musicBlob: options.hasMusic || project.musicSegments.length > 0, sourceAudioBlob: options.hasSourceAudio };
  for (const key of RIPPLE_FIELDS) state[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => { state[key] = typeof value === "function" ? value(state[key]) : value; };
  applyTimelineRipple(state, boundary, delta);
  state.audioSegments = state.audioSegments.map((clip) => fixedAudio.has(clip.id) ? beforeAudio.get(clip.id) : clip);
  state.captionSegments = state.captionSegments.map((clip) => fixedAudio.has(clip.audioSegmentId) ? beforeCaptions.get(clip.id) : clip);
  for (const key of RIPPLE_FIELDS) project[key] = state[key];
}

function prepareAssetOperation(operation, asset, project) {
  if (!asset || asset.preparing || asset.prepareStage === "failed" || !(asset.blob instanceof Blob) || asset.blob.size === 0 || !["image", "video", "audio"].includes(asset.type)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
  if (asset.reversed || asset.speedCurve?.enabled || (asset.playbackRate !== undefined && asset.playbackRate !== 1)) reject("BROWSER_EDIT_COMPLEX_TIMING");
  const assetId = asset.assetId || asset.id;
  const track = operation.type === "visual.insert" ? "visuals" : operation.type === "overlay.add" ? "overlays" : operation.track;
  if (!["visuals", "overlays", "audio", "music"].includes(track)) reject("BROWSER_EDIT_INVALID_PLAN");
  if (asset.kind === "music" && track !== "music") reject("BROWSER_EDIT_INVALID_PLAN");
  if (asset.type === "image" && Object.hasOwn(operation, "muted")) reject("BROWSER_EDIT_INVALID_PLAN");
  const irrelevantFields = track === "visuals" ? ["start", "layer", "transform"]
    : track === "overlays" ? ["atIndex"] : track === "audio" ? ["atIndex", "transform"] : ["atIndex", "transform", "layer"];
  if (irrelevantFields.some((field) => Object.hasOwn(operation, field))) reject("BROWSER_EDIT_INVALID_PLAN");
  const sourceStart = validSourceTime(Number(asset.sourceStart) || 0);
  const sourceDuration = asset.type === "image" ? 0 : validSourceTime(Number(asset.sourceDuration ?? asset.duration), MIN_VISUAL_SEGMENT_SECONDS);
  const duration = operation.duration ?? (asset.type === "image" ? Number(asset.duration) > 0 ? Number(asset.duration) : 4 : sourceDuration);
  validTime(duration, MIN_VISUAL_SEGMENT_SECONDS);
  if (asset.type !== "image" && duration > sourceDuration + TIME_EPSILON) reject("BROWSER_EDIT_INVALID_PLAN");
  const vector = asset.type === "image" && (asset.kind === "vector" || asset.vectorBody)
    ? buildVectorDesignPatch(asset, asset.vectorDesign)
    : null;
  const preparedSource = {
    assetId, archiveMediaId: operation.clipId, type: asset.type, name: String(asset.name || assetId),
    width: Math.max(0, Number(asset.width) || 0), height: Math.max(0, Number(asset.height) || 0),
    sourceStart, sourceDuration, playbackRate: 1, muted: operation.muted === true,
    ...(vector ? { kind: vector.kind, vectorBody: vector.vectorBody, vectorBackground: vector.vectorBackground,
      vectorColorSlots: vector.vectorColorSlots, vectorDesign: vector.vectorDesign } : {}),
    ...(asset.type === "video" ? { sourceAudioUnmapped: true, sourceAudioDisabled: operation.muted === true } : {}),
    ...(asset.type === "audio" ? { volume: track === "music" ? 0.35 : 1, fadeIn: 0, fadeOut: 0 } : {}),
    ...(asset.type === "audio" ? Object.fromEntries(["voiceId", "voiceName", "sourceKind", "cloneVoiceProfileId", "cloneVoiceProfileName"]
      .filter(key => typeof asset[key] === "string").map(key => [key, asset[key]])) : {}),
  };
  const layer = track === "overlays" ? operation.layer ?? project.visualOverlaySegments.reduce((max, clip) => Math.max(max, Number(clip.layer) || 1), 0) + 1 : operation.layer;
  return { ...operation, type: "asset.insert", track, duration, layer, prepared: true, preparedSource };
}

/**
 * Pure multi-track compilation. All metadata mutations go through the shared
 * command reducers; runtime media is restored only from trusted host snapshots.
 */
export function buildBrowserOperationReview(inputProject, response, options = {}) {
  const original = browserCaptionBaseline(completeBrowserProject(inputProject));
  const requested = response?.operations;
  if (!Array.isArray(requested) || !requested.length || requested.length > 500) reject("BROWSER_EDIT_INVALID_PLAN");
  if (response.summary !== undefined && (typeof response.summary !== "string" || response.summary.length > 4000)) reject("BROWSER_EDIT_INVALID_PLAN");
  projectClipMap(original);
  const initialRuntime = { ...original, ...(options.runtimeProject || {}), visualSegments: options.visualSegments || options.runtimeProject?.visualSegments || original.visualSegments };
  if (requested.some(operation => operation.type === "clip.set_enhancement_enabled")) {
    for (const key of ["visualSegments", "visualOverlaySegments"]) original[key] = original[key].map(clip => {
      const effect = initialRuntime[key]?.find(item => item.id === clip.id)?.enhancement;
      if (!effect) return clip;
      const source = value => value ? Object.fromEntries(["assetId", "name", "sourceStart", "sourceDuration", "width", "height"].filter(field => value[field] !== undefined).map(field => [field, value[field]])) : null;
      return { ...clip, enhancement: { ...Object.fromEntries(["preset", "strength", "backend", "pipeline", "frameRate", "totalFrames", "reusedFrames", "audioPreserved", "analysis"].filter(key => effect[key] !== undefined).map(key => [key, effect[key]])), mode: effect.mode, enabled: effect.enabled !== false, original: source(effect.original), processed: source(effect.processed) } };
    });
  }
  if (requested.some(operation => operation.type === "clip.set_repair_enabled")) {
    for (const key of ["visualSegments", "visualOverlaySegments"]) original[key] = original[key].map(clip => {
      const effect = initialRuntime[key]?.find(item => item.id === clip.id)?.repair;
      if (!effect) return clip;
      const source = value => value ? Object.fromEntries(["sourceStart", "sourceDuration", "width", "height"].filter(field => value[field] !== undefined).map(field => [field, value[field]])) : null;
      return { ...clip, repair: { mode: effect.mode, enabled: effect.enabled !== false, original: source(effect.original), processed: source(effect.processed) } };
    });
  }
  for (const key of MEDIA_COLLECTIONS) {
    const snapshots = indexedSegments(original[key] || []);
    const live = indexedSegments(initialRuntime[key] || []);
    if (snapshots.size !== live.size || [...snapshots.keys()].some((id) => !live.has(id))) reject("BROWSER_EDIT_STALE_PLAN");
  }
  const assets = assetMap(options.assets || []);
  const origins = Object.create(null);
  const usedIds = new Set([...projectClipMap(original).keys(), ...(original.timelineMarkers || []).map((marker) => marker.id)]);
  const locks = original.trackLocks || {};
  const originalAudioLanes = audioLaneMap(original);
  const reserve = (id) => { assertId(id); if (usedIds.has(id)) reject("BROWSER_EDIT_INVALID_PLAN"); usedIds.add(id); };
  const inherit = (id, sourceId) => { origins[id] = origins[sourceId] || { kind: "clip", id: sourceId }; };
  const commands = [];
  const warnings = [];
  const removedAssets = [];
  const removedHistory = [];
  let historyRestore;
  let sourceVoiceColor;
  let sourceAudioReplacement;
  let clearSourceAudio = false;
  let clearMusic = false;
  let next = structuredClone(original);
  let focusTime;
  let musicAssetId = null;
  for (const [index, value] of requested.entries()) {
    validateBrowserOperation(value);
    let operation = { ...value };
    if (operation.type === "source.replace_audio") {
      if (locks.source) reject("BROWSER_EDIT_TRACK_LOCKED");
      if (clearSourceAudio || sourceAudioReplacement || sourceVoiceColor || !options.hasSourceAudio || !(initialRuntime.sourceAudioBlob instanceof Blob)) reject("BROWSER_EDIT_INVALID_PLAN");
      const asset = assets.get(operation.assetId);
      if (!asset || asset.type !== "audio" || asset.preparing || !(asset.blob instanceof Blob) || !asset.blob.size || !(asset.src || asset.url)
        || !Number.isFinite(asset.duration) || asset.duration + TIME_EPSILON < next.sourceAudioDuration) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      sourceAudioReplacement = { blob: asset.blob, url: asset.src || asset.url, peaks: asset.peaks || [],
        name: String(asset.name || next.sourceAudioName || "Source audio"), duration: next.sourceAudioDuration };
      next.sourceAudioName = sourceAudioReplacement.name;
      commands.push(operation);
      continue;
    }
    if (operation.type === "track.replace_music") {
      if (locks.music || clearMusic) reject("BROWSER_EDIT_TRACK_LOCKED");
      reserve(operation.clipId);
      validTime(operation.start);
      validTime(operation.duration, MIN_VISUAL_SEGMENT_SECONDS);
      if (operation.start + operation.duration > MAX_TIMELINE_DURATION_SECONDS) reject("BROWSER_EDIT_INVALID_PLAN");
      const asset = assets.get(operation.assetId);
      if (!asset || asset.type !== "audio" || asset.preparing || !(asset.blob instanceof Blob) || !asset.blob.size || !(asset.src || asset.url)
        || !Number.isFinite(asset.duration) || asset.duration + TIME_EPSILON < operation.duration) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      next.musicSegments = [{ id: operation.clipId, assetId: operation.assetId, archiveMediaId: operation.clipId,
        name: String(asset.name || operation.assetId), type: "audio", start: operation.start, duration: operation.duration,
        sourceStart: 0, sourceDuration: operation.duration, playbackRate: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false }];
      next.musicName = String(asset.name || operation.assetId);
      next.musicDuration = asset.duration;
      next.musicStart = operation.start;
      origins[operation.clipId] = { kind: "asset", id: operation.assetId };
      musicAssetId = operation.assetId;
      commands.push(operation);
      continue;
    }
    if (["source.apply_voice_color", "source.restore_voice_color"].includes(operation.type)) {
      if (locks.source) reject("BROWSER_EDIT_TRACK_LOCKED");
      if (clearSourceAudio || sourceAudioReplacement || next.sourceAudioLinked !== false || !(initialRuntime.sourceAudioBlob instanceof Blob)) reject("BROWSER_EDIT_INVALID_PLAN");
      const live = sourceVoiceColor || {
        blob: initialRuntime.sourceAudioBlob, url: initialRuntime.sourceAudioUrl,
        peaks: initialRuntime.sourceAudioPeaks, name: next.sourceAudioName, duration: next.sourceAudioDuration,
        original: initialRuntime.sourceVoiceColorOriginal,
      };
      if (operation.type === "source.apply_voice_color") {
        const asset = assets.get(operation.assetId);
        if (!asset || asset.type !== "audio" || asset.preparing || !(asset.blob instanceof Blob) || !asset.blob.size || !(asset.src || asset.url)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
        assertId(operation.profileName);
        if (!Number.isFinite(asset.duration) || asset.duration + TIME_EPSILON < next.sourceAudioDuration) reject("BROWSER_EDIT_INVALID_PLAN");
        const original = live.original || { blob: live.blob, url: live.url, peaks: live.peaks, name: live.name, duration: live.duration };
        sourceVoiceColor = { blob: asset.blob, url: asset.src || asset.url, peaks: asset.peaks,
          name: `${original.name || "Source audio"} · ${operation.profileName}`, duration: live.duration, original };
      } else {
        if (!(live.original?.blob instanceof Blob) || !live.original.blob.size || !live.original.url) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
        sourceVoiceColor = { ...live.original, original: null };
      }
      next.sourceAudioName = sourceVoiceColor.name;
      next.sourceAudioDuration = sourceVoiceColor.duration;
      commands.push(operation);
      continue;
    }
    if (operation.type === "audio.apply_reverse") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const clip = next.audioSegments.find(item => item.id === operation.clipId);
      if (!clip || typeof operation.reversed !== "boolean") reject("BROWSER_EDIT_INVALID_PLAN");
      if (Boolean(clip.reversed) === operation.reversed) { commands.push(operation); continue; }
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets).audioSegments.find(item => item.id === clip.id);
      const asset = assets.get(operation.assetId);
      if (!asset || asset.type !== "audio" || asset.preparing || !(asset.blob instanceof Blob) || !asset.blob.size || !(asset.src || asset.url)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      const sourceEnd = (Number(clip.sourceStart) || 0) + (Number(clip.sourceDuration) || clip.duration * (Number(clip.playbackRate) || 1));
      if (!Number.isFinite(asset.duration) || asset.duration + TIME_EPSILON < sourceEnd) reject("BROWSER_EDIT_INVALID_PLAN");
      if (!(live.originalBlob instanceof Blob) && !(live.blob instanceof Blob)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      if (!operation.reversed && !(live.originalBlob instanceof Blob)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      const bindings = { ...live.projectMedia?.bindings };
      if (!live.originalBlob && bindings.blob) bindings.originalBlob = bindings.blob;
      delete bindings.blob; delete bindings.url;
      const originalPeaks = live.originalPeaks || live.peaks || [];
      const media = { ...live, blob: asset.blob, url: asset.src || asset.url,
        originalBlob: live.originalBlob || live.blob, originalPeaks,
        peaks: operation.reversed ? [...originalPeaks].reverse() : originalPeaks };
      if (live.projectMedia) media.projectMedia = { ...live.projectMedia, bindings };
      clip.reversed = operation.reversed;
      origins[clip.id] = { kind: "audio-reverse", media, action: operation.type, assetId: operation.assetId };
      commands.push(operation);
      continue;
    }
    if (operation.type === "audio.replace_source") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const clip = next.audioSegments.find(item => item.id === operation.clipId);
      if (!clip) reject("BROWSER_EDIT_INVALID_PLAN");
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets).audioSegments.find(item => item.id === clip.id);
      const asset = assets.get(operation.assetId);
      if (!asset || asset.type !== "audio" || asset.preparing || !(asset.blob instanceof Blob) || !asset.blob.size || !(asset.src || asset.url)
        || !Number.isFinite(asset.duration) || asset.duration + TIME_EPSILON < clip.duration) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      const bindings = { ...live.projectMedia?.bindings };
      delete bindings.blob; delete bindings.url;
      Object.assign(clip, { assetId: operation.assetId, name: String(asset.name || live.name || operation.assetId), sourceKind: "separated",
        sourceStart: 0, sourceDuration: clip.duration, playbackRate: 1, reversed: false });
      delete clip.speedCurve;
      const media = { ...live, ...clip, blob: asset.blob, url: asset.src || asset.url, peaks: asset.peaks || [] };
      for (const key of ["originalBlob", "originalPeaks", "originalSrc"]) {
        delete clip[key];
        delete media[key];
        delete bindings[key];
      }
      if (live.projectMedia) media.projectMedia = { ...live.projectMedia, bindings };
      origins[clip.id] = { kind: "audio-replacement", media, action: operation.type, assetId: operation.assetId };
      commands.push(operation);
      continue;
    }
    if (["audio.apply_voice_color", "audio.restore_voice_color"].includes(operation.type)) {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const clip = next.audioSegments.find(item => item.id === operation.clipId);
      if (!clip) reject("BROWSER_EDIT_INVALID_PLAN");
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets).audioSegments.find(item => item.id === clip.id);
      let media;
      const bindings = { ...live.projectMedia?.bindings };
      if (operation.type === "audio.apply_voice_color") {
        const asset = assets.get(operation.assetId);
        if (!asset || asset.type !== "audio" || asset.preparing || !(asset.blob instanceof Blob) || !asset.blob.size || !(asset.src || asset.url)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
        assertId(operation.profileName);
        const sourceEnd = (Number(clip.sourceStart) || 0) + (Number(clip.sourceDuration) || clip.duration * (Number(clip.playbackRate) || 1));
        if (!Number.isFinite(asset.duration) || asset.duration + TIME_EPSILON < sourceEnd) reject("BROWSER_EDIT_INVALID_PLAN");
        if (!live.voiceColorOriginalBlob) {
          if (bindings.blob) bindings.voiceColorOriginalBlob = bindings.blob;
          if (bindings.url) bindings.voiceColorOriginalUrl = bindings.url;
        }
        delete bindings.blob; delete bindings.url;
        media = { ...live, blob: asset.blob, url: asset.src || asset.url, peaks: asset.peaks,
          name: `${live.voiceColorOriginalName || live.name} · ${operation.profileName}`, voiceName: operation.profileName,
          sourceKind: "cloned-voiceover", cloneVoiceProfileName: operation.profileName,
          voiceColorOriginalBlob: live.voiceColorOriginalBlob || live.blob,
          voiceColorOriginalUrl: live.voiceColorOriginalUrl || live.url,
          voiceColorOriginalPeaks: live.voiceColorOriginalPeaks || live.peaks,
          voiceColorOriginalName: live.voiceColorOriginalName || live.name,
          voiceColorOriginalSourceKind: live.voiceColorOriginalSourceKind || live.sourceKind };
      } else {
        if (!(live.voiceColorOriginalBlob instanceof Blob) || !live.voiceColorOriginalBlob.size || !live.voiceColorOriginalUrl) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
        delete bindings.blob; delete bindings.url; delete bindings.voiceColorOriginalBlob; delete bindings.voiceColorOriginalUrl;
        media = { ...live, blob: live.voiceColorOriginalBlob, url: live.voiceColorOriginalUrl, peaks: live.voiceColorOriginalPeaks,
          name: live.voiceColorOriginalName, sourceKind: live.voiceColorOriginalSourceKind,
          voiceColorOriginalBlob: null, voiceColorOriginalUrl: "", voiceColorOriginalPeaks: null, voiceColorOriginalName: "", voiceColorOriginalSourceKind: "" };
      }
      if (live.projectMedia) media.projectMedia = { ...live.projectMedia, bindings };
      for (const key of ["name", "voiceName", "sourceKind", "cloneVoiceProfileName", "voiceColorOriginalName", "voiceColorOriginalSourceKind"]) {
        if (media[key] !== undefined) clip[key] = media[key];
      }
      origins[clip.id] = { kind: "voice-color", media, action: operation.type, assetId: operation.assetId };
      commands.push(operation);
      continue;
    }
    if (operation.type === "voice.remove_history") {
      const item = options.historyItems?.find(entry => entry.id === operation.historyId);
      if (!item || removedHistory.some(entry => entry.id === item.id)) reject("BROWSER_EDIT_INVALID_PLAN");
      removedHistory.push({ id: item.id, blob: item.blob, script: item.script, duration: item.duration, voiceId: item.voiceId, voiceName: item.voiceName });
      continue;
    }
    if (operation.type === "voice.restore_history") {
      // A history restore replaces the entire script/caption set as one review.
      if (requested.length !== 1) reject("BROWSER_EDIT_INVALID_PLAN");
      assertId(operation.historyId);
      validTime(operation.start);
      const item = options.historyItems?.find(entry => entry.id === operation.historyId);
      if (!item || !(item.blob instanceof Blob) || !item.blob.size) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      const duration = Number(item.duration);
      if (!Number.isFinite(duration) || duration <= 0 || operation.start + duration > MAX_TIMELINE_DURATION_SECONDS) reject("BROWSER_EDIT_INVALID_PLAN");
      if (locks.audio || Object.entries(locks).some(([key, locked]) => locked && (key === "caption" || key.startsWith("caption-")))) reject("BROWSER_EDIT_TRACK_LOCKED");
      reserve(operation.clipId);
      const clip = { id: operation.clipId, start: operation.start, duration, sourceStart: 0, sourceDuration: duration,
        playbackRate: 1, volume: 1, fadeIn: 0, fadeOut: 0, reversed: false, name: item.voiceName || "",
        sourceKind: "ai-voice", voiceId: item.voiceId || "", voiceName: item.voiceName || "", assetId: "" };
      next.audioSegments.push(clip);
      if (locks[getTimedSegmentLaneStateKey(next.audioSegments, clip.id)]) reject("BROWSER_EDIT_TRACK_LOCKED");
      for (const [id, lane] of originalAudioLanes) {
        if (locks[lane] && getTimedSegmentLaneStateKey(next.audioSegments, id) !== lane) reject("BROWSER_EDIT_TRACK_LOCKED");
      }
      next.script = String(item.script || "");
      next.captionSegments = createCaptionSegments(next.script);
      origins[clip.id] = { kind: "history", id: item.id };
      historyRestore = { historyId: item.id, clipId: clip.id, blob: item.blob, script: item.script, duration: item.duration, voiceId: item.voiceId, voiceName: item.voiceName };
      focusTime = operation.start;
      continue;
    }
    if (operation.type === "track.clear_music") {
      if (locks.music) reject("BROWSER_EDIT_TRACK_LOCKED");
      if ((!options.hasMusic && !next.musicSegments.length) || clearMusic) reject("BROWSER_EDIT_INVALID_PLAN");
      clearMusic = true;
      musicAssetId = null;
      Object.assign(next, { musicSegments: [], musicName: "", musicDuration: 0, musicStart: 0 });
      continue;
    }
    if (clearMusic && (operation.track === "music" || next.musicSegments.some(clip => clip.id === operation.clipId))) reject("BROWSER_EDIT_INVALID_PLAN");
    if (operation.type === "track.clear_source_audio") {
      if (locks.source) reject("BROWSER_EDIT_TRACK_LOCKED");
      if (!options.hasSourceAudio || clearSourceAudio) reject("BROWSER_EDIT_INVALID_PLAN");
      clearSourceAudio = true;
      Object.assign(next, { sourceAudioName: "", sourceAudioDuration: 0, sourceAudioStart: 0,
        sourceAudioAssetId: "", sourceAudioLinked: true, sourceAudioSpatialEffect: "original", sourceAudioSpatialAmount: 1 });
      continue;
    }
    if (operation.type === "asset.remove_from_library") {
      const asset = assets.get(operation.assetId);
      if (!asset || removedAssets.some(item => item.assetId === operation.assetId)) reject("BROWSER_EDIT_INVALID_PLAN");
      removedAssets.push({ id: asset.id, assetId: operation.assetId, name: asset.name || "", type: asset.type });
      continue;
    }
    const beforeVisuals = next.visualSegments;
    const beforeLinkedCaptions = next.captionSegments.filter(caption => caption.visualSegmentId);
    const durationBefore = beforeVisuals.reduce((sum, clip) => sum + Number(clip.duration), 0);
    let boundary;
    const sourceIndex = beforeVisuals.findIndex((clip) => clip.id === operation.clipId);
    const clipStart = sourceIndex >= 0 ? beforeVisuals.slice(0, sourceIndex).reduce((sum, clip) => sum + Number(clip.duration), 0) : 0;
    const isInsertion = ["visual.insert", "overlay.add", "asset.insert"].includes(operation.type);
    if (operation.type.startsWith("visual.") || operation.type === "asset.insert" && operation.track === "visuals") {
      if (locks.image) reject("BROWSER_EDIT_TRACK_LOCKED");
    }
    if (operation.type === "transition.set") {
      if (sourceIndex < 0) reject("BROWSER_EDIT_INVALID_PLAN");
      if (locks.image) reject("BROWSER_EDIT_TRACK_LOCKED");
    }
    if (operation.type.startsWith("caption.")) {
      if (locks.caption) reject("BROWSER_EDIT_TRACK_LOCKED");
      if (operation.type === "caption.add") reserve(operation.clipId);
      if (operation.type === "caption.split") reserve(operation.rightClipId);
      if (operation.type === "caption.duplicate") reserve(operation.newClipId);
    }
    if (["track.set_source_audio", "source.set_volume"].includes(operation.type)) {
      if (clearSourceAudio) reject("BROWSER_EDIT_INVALID_PLAN");
      if (locks.source) reject("BROWSER_EDIT_TRACK_LOCKED");
      if (!options.hasSourceAudio) reject("BROWSER_EDIT_INVALID_PLAN");
    }
    if (operation.type === "marker.add") reserve(operation.markerId);
    if (operation.type.startsWith("timed.") || operation.type === "clip.delete" || operation.type === "overlay.set_transform") {
      const { key, clip } = findProjectClip(next, operation.clipId);
      const expected = operation.type === "overlay.set_transform" ? "visualOverlaySegments"
        : { audio: "audioSegments", music: "musicSegments", overlays: "visualOverlaySegments", stickers: "stickerSegments" }[operation.track];
      if (key !== expected) reject("BROWSER_EDIT_INVALID_PLAN");
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      if (operation.track === "audio") {
        if (locks.caption && next.captionSegments.some((caption) => caption.audioSegmentId === clip.id
          || operation.type === "clip.delete" && caption.detachedAudioSegmentId === clip.id)) reject("BROWSER_EDIT_TRACK_LOCKED");
        if (!["timed.split", "timed.duplicate"].includes(operation.type)) prepareAudioLaneEdit(next, operation, locks);
      }
      if (operation.type === "timed.duplicate") {
        if (!["audio", "music", "overlays", "stickers"].includes(operation.track)) reject("BROWSER_EDIT_INVALID_PLAN");
        reserve(operation.newClipId); inherit(operation.newClipId, operation.clipId);
        for (const caption of operation.captionCopies || []) reserve(caption.newClipId);
        if (operation.track === "audio") {
          for (const item of next.audioSegments) if (!Number.isInteger(item.lane)) item.lane = Number(getTimedSegmentLaneStateKey(next.audioSegments, item.id).slice(6));
        }
      }
      if (operation.type === "timed.split") {
        reserve(operation.rightClipId); inherit(operation.rightClipId, operation.clipId);
        if (operation.track === "audio") {
          for (const item of next.audioSegments) if (!Number.isInteger(item.lane)) item.lane = Number(getTimedSegmentLaneStateKey(next.audioSegments, item.id).slice(6));
        }
      }
      if (["timed.resize", "timed.trim"].includes(operation.type)) {
        if (operation.type === "timed.resize") validTime(operation.duration, MIN_VISUAL_SEGMENT_SECONDS);
        else {
          validSourceTime(operation.sourceIn); validSourceTime(operation.sourceOut);
          if (operation.track === "overlays" && clip.type === "video" && clip.speedCurve?.enabled) {
            let trimmed;
            try { trimmed = trimVisualSegmentState(clip, operation.sourceIn, operation.sourceOut); } catch { reject("BROWSER_EDIT_INVALID_PLAN"); }
            validTime(trimmed.duration, MIN_VISUAL_SEGMENT_SECONDS);
          } else {
            const rate = Math.max(0.25, Math.min(4, Number(clip.playbackRate) || 1));
            validTime((operation.sourceOut - operation.sourceIn) / rate, MIN_VISUAL_SEGMENT_SECONDS);
          }
        }
        if (operation.track === "overlays" && clip.type === "video") {
          const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets).visualOverlaySegments.find((item) => item.id === clip.id);
          if (clip.speedCurve?.enabled) {
            if (!supportsBrowserSourceRangeEdit(clip) || !supportsBrowserSourceRangeEdit(live)) reject("BROWSER_EDIT_COMPLEX_TIMING");
          } else {
            assertPlainVisual({ ...clip, playbackRate: 1 }); assertPlainVisual({ ...live, playbackRate: 1 });
          }
        }
        if (clip.reversed || clip.reverse || clip.speedCurve?.enabled && !(operation.track === "overlays" && clip.type === "video")) reject("BROWSER_EDIT_COMPLEX_TIMING");
      }
      focusTime = operation.start ?? clip.start;
    }
    if (operation.type === "clip.set_property" || operation.type === "clip.set_muted" || operation.type === "clip.set_spatial" || operation.type === "sticker.set_transform") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const { key, clip } = findProjectClip(next, operation.clipId);
      if (operation.type === "clip.set_property") {
        if (!["audioSegments", "musicSegments"].includes(key) || !["volume", "fadeIn", "fadeOut"].includes(operation.property)) reject("BROWSER_EDIT_INVALID_PLAN");
        if (operation.property !== "volume" && operation.value > clip.duration) reject("BROWSER_EDIT_INVALID_PLAN");
      }
    }
    if (["clip.keyframe_set", "clip.keyframe_remove", "clip.set_filter", "clip.set_animation", "clip.set_color_grade", "clip.set_mask", "clip.set_subject_effect", "clip.set_subject_background_media", "clip.set_click_ripple", "clip.set_cinematic_depth", "clip.set_photo_parallax", "clip.set_vector_design", "clip.set_vector_part", "clip.apply_smart_frame", "clip.remove_smart_frame", "clip.apply_caption_avoidance", "clip.set_caption_avoidance"].includes(operation.type)) {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
    }
    if (operation.type === "clip.apply_depth_analysis") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const { clip, key } = findProjectClip(next, operation.clipId);
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key]?.find(item => item.id === clip.id);
      const asset = assets.get(operation.sourceAssetId);
      if (!["visualSegments", "visualOverlaySegments"].includes(key) || !["image", "video"].includes(clip.type)
        || !asset || asset.type !== clip.type || !(asset.blob instanceof Blob) || asset.blob !== live?.blob) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      const quality = validateDepthAnalysis(operation.analysis, live);
      operation = { ...operation, prepared: true, preparedDepth: { ...operation.analysis, signature: getDepthAnalysisSignature(live, quality) } };
    }
    if (operation.type === "clip.apply_vision_cutout") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const { clip, key } = findProjectClip(next, operation.clipId);
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key]?.find(item => item.id === clip.id);
      const source = assets.get(operation.sourceAssetId), cutout = assets.get(operation.assetId);
      if (!["visualSegments", "visualOverlaySegments"].includes(key) || clip.type !== "image"
        || !source || source.type !== "image" || !(source.blob instanceof Blob) || source.blob !== live?.blob
        || !cutout || cutout.type !== "image" || cutout.preparing || !(cutout.blob instanceof Blob) || !cutout.blob.size || !cutout.src
        || !(cutout.width > 0) || !(cutout.height > 0) || operation.sourceAssetId === operation.assetId) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      operation = { ...operation, prepared: true, preparedVision: {
        kind: "image-cutout", complete: true, visualType: "image",
        sourceAssetId: operation.sourceAssetId, cutoutAssetId: operation.assetId,
        sourceSize: { width: cutout.width, height: cutout.height }, options: { removeBackground: true },
      } };
    }
    if (operation.type === "clip.set_subject_background_media") {
      const { clip, key } = findProjectClip(next, operation.clipId);
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key]?.find(item => item.id === clip.id);
      const asset = assets.get(operation.assetId);
      const reusableMask = live?.type === "image"
        ? Boolean(live.vision?.cutoutUrl)
        : live?.type === "video" && live.vision?.samples?.some(sample => sample?.cutoutUrl);
      const fit = operation.fitMode ?? "cover", opacity = operation.opacity ?? 1;
      if (!["visualSegments", "visualOverlaySegments"].includes(key) || !["image", "video"].includes(clip.type)
        || !reusableMask || !asset || !["image", "video"].includes(asset.type) || asset.preparing
        || asset.prepareStage === "failed" || !(asset.blob instanceof Blob) || !asset.blob.size || !(asset.src || asset.url)
        || !(asset.width > 0) || !(asset.height > 0) || asset.type === "video" && !(asset.duration > 0)
        || !["cover", "contain"].includes(fit) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      }
      operation = { ...operation, prepared: true, preparedBackground: {
        mode: asset.type, assetId: operation.assetId, fit, opacity,
      } };
    }
    if (operation.type === "clip.apply_caption_avoidance") {
      const { clip, key } = findProjectClip(next, operation.clipId);
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key]?.find(item => item.id === clip.id);
      const source = assets.get(operation.sourceAssetId);
      if (!["visualSegments", "visualOverlaySegments"].includes(key) || !["image", "video"].includes(clip.type)
        || !source || source.type !== clip.type || !(source.blob instanceof Blob) || source.blob !== live?.blob) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      operation = { ...operation, prepared: true,
        preparedVision: prepareCaptionAvoidanceAnalysis(operation.analysis, live, operation.sourceAssetId) };
    }
    if (operation.type === "clip.set_caption_avoidance") {
      const { clip, key } = findProjectClip(next, operation.clipId);
      if (!["visualSegments", "visualOverlaySegments"].includes(key) || typeof operation.enabled !== "boolean"
        || !clip.vision || operation.enabled && !(clip.vision.subject?.box || clip.vision.samples?.some(sample => sample?.subject?.box))) {
        reject("BROWSER_EDIT_INVALID_PLAN");
      }
    }
    if (operation.type === "clip.apply_smart_frame") {
      const { clip, key } = findProjectClip(next, operation.clipId);
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key]?.find(item => item.id === clip.id);
      const source = assets.get(operation.sourceAssetId), smartFrame = normalizeSmartFrame(operation.smartFrame);
      const signature = smartFrame?.sourceSignature || {};
      const sourceStart = Math.max(0, Number(live?.sourceStart) || 0);
      const sourceDuration = Math.max(0, Number(live?.sourceDuration) || Number(live?.duration) || 0);
      const playbackRate = Math.max(0.25, Math.min(4, Number(live?.playbackRate) || 1));
      if (!["visualSegments", "visualOverlaySegments"].includes(key) || !["image", "video"].includes(clip.type)
        || !source || source.type !== clip.type || !(source.blob instanceof Blob) || source.blob !== live?.blob || !smartFrame
        || !["16:9", "9:16", "1:1", "4:5"].includes(smartFrame.targetRatio)
        || ![signature.sourceStart, signature.sourceDuration, signature.playbackRate].every(value => Number.isFinite(Number(value)))
        || signature.assetId !== operation.sourceAssetId || Math.abs(Number(signature.sourceStart) - sourceStart) > TIME_EPSILON
        || Math.abs(Number(signature.sourceDuration) - sourceDuration) > TIME_EPSILON
        || Math.abs(Number(signature.playbackRate) - playbackRate) > TIME_EPSILON) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      operation = { ...operation, prepared: true, preparedSmartFrame: smartFrame };
    }
    if (operation.type === "clip.remove_smart_frame") {
      const { clip, key } = findProjectClip(next, operation.clipId);
      if (!["visualSegments", "visualOverlaySegments"].includes(key) || !normalizeSmartFrame(clip.smartFrame)) reject("BROWSER_EDIT_INVALID_PLAN");
    }
    if (operation.type === "clip.apply_enhancement") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const { clip, key } = findProjectClip(next, operation.clipId);
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key]?.find(item => item.id === clip.id);
      const asset = assets.get(operation.assetId);
      if (!["visualSegments", "visualOverlaySegments"].includes(key) || !(clip.type === "video" || clip.type === "image" && operation.mode === "nanovsr-644k") || !asset || asset.type !== clip.type
        || asset.preparing || !(asset.blob instanceof Blob) || !asset.blob.size || !asset.src
        || !["smart-denoise-drunet", "nanovsr-644k", "remaster-drunet-full"].includes(operation.mode)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      const sourceDuration = Number(clip.sourceDuration) || clip.duration * (Number(clip.playbackRate) || 1);
      if (clip.type === "video" && (!Number.isFinite(asset.duration) || Math.abs(asset.duration - sourceDuration) > 0.001)
        || !(asset.width > 0) || !(asset.height > 0)) reject("BROWSER_EDIT_INVALID_PLAN");
      const originalSource = live.enhancement?.original || live;
      operation = { ...operation, prepared: true, preparedEnhancement: {
        mode: operation.mode, enabled: true,
        original: Object.fromEntries(["sourceStart", "sourceDuration", "width", "height"].filter(field => originalSource[field] !== undefined).map(field => [field, originalSource[field]])),
        processed: { assetId: operation.assetId, name: String(asset.name || operation.assetId), sourceStart: 0, sourceDuration: clip.type === "video" ? asset.duration : clip.duration, width: asset.width, height: asset.height },
      } };
    }
    if (operation.type === "clip.set_enhancement_enabled") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const { key } = findProjectClip(next, operation.clipId);
      const effect = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key]?.find(item => item.id === operation.clipId)?.enhancement;
      const source = operation.enabled ? effect?.processed : effect?.original;
      if (!source?.src || !["remaster-drunet-full", "nanovsr-644k", "smart-denoise-drunet"].includes(effect?.mode)) reject("BROWSER_EDIT_INVALID_PLAN");
    }
    if (operation.type === "clip.apply_repair") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const { clip, key } = findProjectClip(next, operation.clipId);
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key]?.find(item => item.id === clip.id);
      const asset = assets.get(operation.assetId);
      if (!["visualSegments", "visualOverlaySegments"].includes(key) || !["image", "video"].includes(clip.type)
        || !asset || asset.type !== clip.type || asset.preparing || !(asset.blob instanceof Blob) || !asset.blob.size || !asset.src
        || !(asset.width > 0) || !(asset.height > 0)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      const sourceDuration = Number(clip.sourceDuration) || clip.duration * (Number(clip.playbackRate) || 1);
      if (clip.type === "video" && (!Number.isFinite(asset.duration) || Math.abs(asset.duration - sourceDuration) > 0.001
        || clip.speedCurve?.enabled || clip.reverse || clip.reversed)) reject("BROWSER_EDIT_INVALID_PLAN");
      validateMiganRegions(operation.regions, clip.type === "video", sourceDuration / (Number(clip.playbackRate) || 1));
      const originalSource = live.repair?.original || live;
      operation = { ...operation, prepared: true, preparedRepair: {
        mode: "migan-256-webgpu", enabled: true,
        original: Object.fromEntries(["sourceStart", "sourceDuration", "width", "height"].filter(field => originalSource[field] !== undefined).map(field => [field, originalSource[field]])),
        processed: { assetId: operation.assetId, sourceStart: 0, sourceDuration: clip.type === "video" ? asset.duration : clip.duration, width: asset.width, height: asset.height },
      } };
    }
    if (operation.type === "clip.set_repair_enabled") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const { key } = findProjectClip(next, operation.clipId);
      const effect = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key]?.find(item => item.id === operation.clipId)?.repair;
      const source = operation.enabled ? effect?.processed : effect?.original;
      if (!source?.src || !(source.blob instanceof Blob) || !source.blob.size || effect?.mode !== "migan-256-webgpu") reject("BROWSER_EDIT_INVALID_PLAN");
    }
    if (operation.type === "clip.set_speed" || operation.type === "clip.set_speed_curve") {
      assertClipUnlocked(next, operation.clipId, locks, originalAudioLanes);
      const { key, clip } = findProjectClip(next, operation.clipId);
      if (operation.type === "clip.set_speed" && (clip.reversed || clip.reverse ||
          Object.values(clip.propertyKeyframes || {}).some(frames => frames?.length))) reject("BROWSER_EDIT_COMPLEX_TIMING");
      if (!["audioSegments", "musicSegments", "visualSegments", "visualOverlaySegments"].includes(key) ||
          key.startsWith("visual") && clip.type !== "video") reject("BROWSER_EDIT_INVALID_PLAN");
      if (key === "audioSegments" && locks.caption && next.captionSegments.some(caption => caption.audioSegmentId === clip.id)) reject("BROWSER_EDIT_TRACK_LOCKED");
      if (key === "visualSegments") {
        boundary = clipStart + clip.duration;
      }
    }
    if (operation.type === "visual.split" || operation.type === "visual.trim") {
      const clip = beforeVisuals[sourceIndex];
      const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets).visualSegments.find((item) => item.id === operation.clipId);
      if (!supportsBrowserSourceRangeEdit(clip) || !supportsBrowserSourceRangeEdit(live)) reject("BROWSER_EDIT_COMPLEX_TIMING");
      if (hasTransition(beforeVisuals[sourceIndex - 1])) reject("BROWSER_EDIT_COMPLEX_TIMING");
      if (operation.type === "visual.split") {
        validTime(operation.at, MIN_VISUAL_SEGMENT_SECONDS);
        if (clip.duration - operation.at < MIN_VISUAL_SEGMENT_SECONDS) reject("BROWSER_EDIT_INVALID_PLAN");
        reserve(operation.rightClipId); inherit(operation.rightClipId, operation.clipId);
        focusTime = clipStart + operation.at;
      } else {
        if (clip.type !== "video") reject("BROWSER_EDIT_INVALID_PLAN");
        let trimmed;
        try { trimmed = trimVisualSegmentState(clip, operation.sourceIn, operation.sourceOut); } catch { reject("BROWSER_EDIT_INVALID_PLAN"); }
        if (trimmed.duration < MIN_VISUAL_SEGMENT_SECONDS) reject("BROWSER_EDIT_INVALID_PLAN");
        boundary = clipStart + clip.duration;
      }
    }
    if (operation.type === "visual.delete") {
      if (sourceIndex < 0) reject("BROWSER_EDIT_INVALID_PLAN");
      boundary = clipStart + beforeVisuals[sourceIndex].duration;
      focusTime = clipStart;
    }
    if (operation.type === "visual.duplicate") {
      if (sourceIndex < 0) reject("BROWSER_EDIT_INVALID_PLAN");
      reserve(operation.newClipId); inherit(operation.newClipId, operation.clipId);
      operation.atIndex ??= sourceIndex + 1;
      boundary = beforeVisuals.slice(0, operation.atIndex).reduce((sum, clip) => sum + Number(clip.duration), 0);
      focusTime = boundary;
    }
    if (operation.type === "sticker.add") {
      if (locks.sticker) reject("BROWSER_EDIT_TRACK_LOCKED");
      reserve(operation.clipId);
      if (!STICKER_LIBRARY.some(item => item.id === operation.stickerId)) reject("BROWSER_EDIT_INVALID_PLAN");
      origins[operation.clipId] = { kind: "builtin-sticker", id: operation.stickerId };
      focusTime = operation.start;
    }
    if (isInsertion) {
      reserve(operation.clipId);
      if (Boolean(operation.assetId) === Boolean(operation.sourceClipId)) reject("BROWSER_EDIT_INVALID_PLAN");
      if (operation.assetId) {
        const asset = assets.get(operation.assetId);
        operation = prepareAssetOperation(operation, asset, next);
        origins[operation.clipId] = { kind: "asset", id: operation.assetId };
      } else {
        const { clip, key } = findProjectClip(next, operation.sourceClipId);
        if (!["visualSegments", "visualOverlaySegments"].includes(key)) reject("BROWSER_EDIT_INVALID_PLAN");
        const live = restoreBrowserProjectMedia(next, initialRuntime, origins, options.assets)[key].find((item) => item.id === operation.sourceClipId);
        assertPlainVisual(clip); assertPlainVisual(live);
        inherit(operation.clipId, operation.sourceClipId);
      }
      const track = operation.type === "visual.insert" ? "visuals" : operation.type === "overlay.add" ? "overlays" : operation.track;
      if (locks[{ visuals: "image", overlays: "overlay", audio: "audio", music: "music" }[track]]) reject("BROWSER_EDIT_TRACK_LOCKED");
      if (track === "visuals") {
        boundary = beforeVisuals.slice(0, operation.atIndex).reduce((sum, clip) => sum + Number(clip.duration), 0);
        focusTime = boundary;
      } else {
        validTime(operation.start);
        focusTime = operation.start;
      }
      if (track === "music") {
        const asset = assets.get(operation.assetId);
        if (!asset || musicAssetId && musicAssetId !== operation.assetId
          || (next.musicSegments.length || Number(next.musicDuration) > 0 && (options.hasMusic || initialRuntime.musicBlob)) && initialRuntime.musicBlob !== asset.blob) reject("BROWSER_EDIT_MULTIPLE_MUSIC_SOURCES");
        musicAssetId = operation.assetId;
        const end = operation.start + operation.duration;
        if (next.musicSegments.some((clip) => clip.start < end - TIME_EPSILON && clip.start + clip.duration > operation.start + TIME_EPSILON)) reject("BROWSER_EDIT_MUSIC_OVERLAP");
      }
      if (track === "audio") {
        // Freeze existing lane placement before adding a voice clip. New clips
        // go to their requested lane or a new lane, without moving siblings.
        for (const clip of next.audioSegments) {
          if (!Number.isInteger(clip.lane)) clip.lane = Number(getTimedSegmentLaneStateKey(next.audioSegments, clip.id).slice(6));
        }
        operation.lane = operation.layer === undefined ? Math.max(-1, ...next.audioSegments.map((clip) => clip.lane || 0)) + 1 : operation.layer - 1;
        if (locks[`audio-${operation.lane}`]) reject("BROWSER_EDIT_TRACK_LOCKED");
      }
    }
    operation.id = `browser-${crypto.randomUUID()}-${index}`;
    const result = applyCommandPlan(next, { schemaVersion: 1, baseRevision: next.commandState?.revision || 0, operations: [operation] });
    if (!result.ok) reject(result.code === "REVISION_CONFLICT" ? "BROWSER_EDIT_STALE_PLAN" : "BROWSER_EDIT_INVALID_PLAN");
    next = completeBrowserProject(result.project);
    if (operation.type === "timed.duplicate" && operation.track === "audio") {
      const lane = getTimedSegmentLaneStateKey(next.audioSegments, operation.newClipId);
      if (locks[lane]) reject("BROWSER_EDIT_TRACK_LOCKED");
      next.audioSegments.find(item => item.id === operation.newClipId).lane = Number(lane.slice(6));
    }
    warnings.push(...result.warnings);
    if (operation.type === "clip.delete" && operation.track === "music" && !next.musicSegments.length) musicAssetId = null;
    if (["timed.move", "timed.resize"].includes(operation.type) && operation.track === "music") {
      const changed = next.musicSegments.find((clip) => clip.id === operation.clipId);
      if (next.musicSegments.some((clip) => clip.id !== changed.id && clip.start < changed.start + changed.duration - TIME_EPSILON
        && clip.start + clip.duration > changed.start + TIME_EPSILON)) reject("BROWSER_EDIT_MUSIC_OVERLAP");
    }
    if (operation.type === "asset.insert" && operation.track === "audio") {
      const actualLane = getTimedSegmentLaneStateKey(next.audioSegments, operation.clipId);
      if (locks[actualLane] || operation.layer !== undefined && actualLane !== `audio-${operation.lane}`) reject("BROWSER_EDIT_TRACK_LOCKED");
    }
    commands.push(operation);
    const durationAfter = next.visualSegments.reduce((sum, clip) => sum + Number(clip.duration), 0);
    if (boundary !== undefined) applyBrowserRipple(next, boundary, durationAfter - durationBefore, options, originalAudioLanes, locks);
    if (beforeLinkedCaptions.length && (operation.type.startsWith("visual.") || operation.type === "clip.set_speed" || operation.type === "clip.set_speed_curve" ||
        operation.type === "asset.insert" && operation.track === "visuals")) {
      let beforeStart = 0, afterStart = 0;
      const beforeMap = new Map(beforeVisuals.map(clip => { const value = { clip, start: beforeStart }; beforeStart += clip.duration; return [clip.id, value]; }));
      const afterMap = new Map(next.visualSegments.map(clip => { const value = { clip, start: afterStart }; afterStart += clip.duration; return [clip.id, value]; }));
      for (const caption of beforeLinkedCaptions) {
        const before = beforeMap.get(caption.visualSegmentId), after = afterMap.get(caption.visualSegmentId);
        if (!before) reject("BROWSER_EDIT_INVALID_PLAN");
        const currentCaption = next.captionSegments.find(item => item.id === caption.id);
        if (!currentCaption) continue;
        if (operation.type === "visual.split" && caption.visualSegmentId === operation.clipId) {
          if (caption.end > before.start + operation.at) {
            if (caption.start < before.start + operation.at) reject("BROWSER_EDIT_COMPLEX_TIMING");
            if (locks.caption) reject("BROWSER_EDIT_TRACK_LOCKED");
            currentCaption.visualSegmentId = operation.rightClipId;
          }
          continue;
        }
        const oldRate = Number(before.clip.playbackRate) || 1, newRate = Number(after?.clip.playbackRate) || 1;
        const mapTime = time => {
          if (operation.type === "visual.trim" && before.clip.id === operation.clipId && (before.clip.speedCurve?.enabled || after.clip.speedCurve?.enabled)) {
            const sourceTime = getVisualSourceTime(before.clip, time - before.start);
            const progress = (sourceTime - (Number(after.clip.sourceStart) || 0)) / after.clip.sourceDuration;
            return after.start + getVisualSpeedCurveTimelineProgress(after.clip.speedCurve, progress) * after.clip.duration;
          }
          if (!["clip.set_speed_curve", "clip.set_speed"].includes(operation.type) || before.clip.id !== operation.clipId) return after.start + ((time - before.start) * oldRate + (Number(before.clip.sourceStart) || 0) - (Number(after.clip.sourceStart) || 0)) / newRate;
          const sourceTime = getVisualSourceTime(before.clip, time - before.start);
          if (operation.type === "clip.set_speed") return after.start + (sourceTime - (Number(after.clip.sourceStart) || 0)) / newRate;
          const progress = (sourceTime - (Number(after.clip.sourceStart) || 0)) / after.clip.sourceDuration;
          return after.start + getVisualSpeedCurveTimelineProgress(after.clip.speedCurve, progress) * after.clip.duration;
        };
        const start = after ? Math.max(after.start, mapTime(caption.start)) : 0;
        const end = after ? Math.min(after.start + after.clip.duration, mapTime(caption.end)) : 0;
        if (locks.caption && (!after || start !== caption.start || end !== caption.end)) reject("BROWSER_EDIT_TRACK_LOCKED");
        if (!after || end <= start) { next.captionSegments = next.captionSegments.filter(item => item.id !== caption.id); continue; }
        if (end - start < 0.2 - TIME_EPSILON) reject("BROWSER_EDIT_COMPLEX_TIMING");
        Object.assign(currentCaption, { start, end });
        if (Array.isArray(caption.words)) currentCaption.words = caption.words.flatMap(word => {
          const wordStart = Math.max(start, mapTime(word.start)), wordEnd = Math.min(end, mapTime(word.end));
          return wordEnd > wordStart ? [{ ...word, start: wordStart, end: wordEnd }] : [];
        });
      }
    }
    if (durationAfter > MAX_TIMELINE_DURATION_SECONDS || next.visualSegments.some((clip) => clip.duration < MIN_VISUAL_SEGMENT_SECONDS)
      || projectDuration(next, { ...options, hasMusic: options.hasMusic || Boolean(musicAssetId) }) > MAX_TIMELINE_DURATION_SECONDS) reject("BROWSER_EDIT_INVALID_PLAN");
    assertLockedSourceUnchanged(original, next, options);
    for (const [id, lane] of originalAudioLanes) {
      if (locks.audio || locks[lane]) {
        const before = original.audioSegments.find((clip) => clip.id === id);
        const after = next.audioSegments.find((clip) => clip.id === id);
        const { lane: _beforeLane, ...beforeContent } = before;
        const { lane: _afterLane, ...afterContent } = after || {};
        if (JSON.stringify(beforeContent) !== JSON.stringify(afterContent) || getTimedSegmentLaneStateKey(next.audioSegments, id) !== lane) reject("BROWSER_EDIT_TRACK_LOCKED");
      }
    }
  }
  const diff = diffProjects(original, next);
  if (sourceAudioReplacement && !clearSourceAudio && sourceAudioReplacement.blob !== initialRuntime.sourceAudioBlob) {
    diff.tracks.source = { added: [], removed: [], modified: [{ id: "source-audio", fields: ["sourceMedia"], before: {}, after: {} }] };
  }
  if (sourceVoiceColor && !clearSourceAudio && (sourceVoiceColor.blob !== initialRuntime.sourceAudioBlob || sourceVoiceColor.original !== initialRuntime.sourceVoiceColorOriginal)) {
    diff.tracks.source = { added: [], removed: [], modified: [{ id: "source-audio", fields: ["voiceColorAudio"], before: {}, after: {} }] };
  }
  for (const [clipId, origin] of Object.entries(origins)) {
    if (origin.kind !== "voice-color" || initialRuntime.audioSegments?.find(item => item.id === clipId)?.blob === origin.media.blob) continue;
    const change = diff.tracks.audio ??= { added: [], removed: [], modified: [] };
    if (!change.added.includes(clipId) && !change.removed.includes(clipId)) {
      let entry = change.modified.find(item => item.id === clipId);
      if (!entry) { entry = { id: clipId, fields: [], before: {}, after: {} }; change.modified.push(entry); }
      entry.fields.push("voiceColorAudio"); entry.before.voiceColorAudio = null;
      entry.after.voiceColorAudio = { action: origin.action, ...(origin.assetId ? { assetId: origin.assetId } : {}) };
    }
  }
  if (removedHistory.length) diff.tracks.voiceHistory = {
    added: [], removed: removedHistory.map(item => item.id), modified: [],
    removedEntries: removedHistory.map(item => ({ id: item.id, name: item.voiceName || "", text: item.script || "", duration: item.duration || 0 })),
  };
  if (clearMusic && !original.musicSegments.length) diff.tracks.music = {
    added: [], removed: ["music-audio"], modified: [],
    removedEntries: [{ id: "music-audio", name: original.musicName || "", type: "audio", duration: original.musicDuration || 0 }],
  };
  if (clearSourceAudio) diff.tracks.source = {
    added: [], removed: ["source-audio"], modified: [],
    removedEntries: [{ id: "source-audio", name: original.sourceAudioName || "", type: "audio", duration: original.sourceAudioDuration || 0 }],
  };
  if (removedAssets.length) diff.tracks.assets = {
    added: [], removed: removedAssets.map(asset => asset.assetId), modified: [],
    removedEntries: removedAssets.map(asset => ({ id: asset.assetId, name: asset.name, type: asset.type })),
  };
  for (const field of ["musicStart", "sourceAudioStart", "musicName", "musicDuration", "sourceAudioName", "sourceAudioDuration"]) {
    if (original[field] !== next[field]) diff.projectFields.push({ field, before: original[field] ?? null, after: next[field] ?? null });
  }
  const changes = [
    ...Object.entries(diff.tracks).flatMap(([track, change]) => [
      ...change.added.map((id) => ({ track, id, action: "added" })),
      ...change.removed.map((id) => ({ track, id, action: "removed" })),
      ...change.modified.map((entry) => ({ track, id: entry.id, action: "modified", fields: entry.fields })),
      ...(change.orderBefore && !change.added.length && !change.removed.length ? [{ track, action: "reordered" }] : []),
    ]),
    ...(diff.markers?.added || []).map((marker) => ({ track: "markers", id: marker.id, action: "added" })),
    ...(diff.markers?.removed || []).map((marker) => ({ track: "markers", id: marker.id, action: "removed" })),
    ...(diff.markers?.modified || []).map((marker) => ({ track: "markers", id: marker.id, action: "modified", fields: marker.fields })),
    ...diff.projectFields.map((entry) => ({ track: "project", action: "modified", fields: [entry.field] })),
  ];
  const hasChanges = changes.length > 0;
  if (hasChanges) next.commandState = { ...next.commandState, revision: (original.commandState?.revision || 0) + 1 };
  else next = structuredClone(original);
  let beforeCursor = 0;
  const beforeById = new Map(original.visualSegments.map((clip, index) => {
    const before = { clip, index, start: beforeCursor }; beforeCursor += clip.duration; return [clip.id, before];
  }));
  let cursor = 0;
  const rows = next.visualSegments.map((clip, index) => {
    const before = beforeById.get(clip.id);
    const row = { id: clip.id, name: clip.name || clip.id, index, beforeIndex: before?.index ?? -1,
      beforeStart: before?.start ?? 0, start: cursor, beforeDuration: before?.clip.duration ?? 0, duration: clip.duration,
      beforeSourceStart: before?.clip.sourceStart || 0, sourceStart: clip.sourceStart || 0,
      added: !before, reordered: Boolean(before && before.index !== index),
      trimmed: Boolean(before && (clip.duration !== before.clip.duration || (clip.sourceStart || 0) !== (before.clip.sourceStart || 0))),
      changed: !before || JSON.stringify(before.clip) !== JSON.stringify(clip) || before.index !== index };
    cursor += clip.duration; return row;
  });
  return { project: next, beforeProject: original, operations: commands, removedAssets, removedHistory, historyRestore, sourceVoiceColor, sourceAudioReplacement, clearSourceAudio, clearMusic, mediaOrigins: origins, rows, diff, changes, hasChanges, warnings,
    visualsChanged: Boolean(diff.tracks.visuals), summary: response.summary || "", title: "",
    changeSummary: { reordered: rows.filter((row) => row.reordered).length, trimmed: rows.filter((row) => row.trimmed).length },
    beforeDuration: projectDuration(original, options), duration: projectDuration(next, { ...options, hasSourceAudio: options.hasSourceAudio && !clearSourceAudio, hasMusic: options.hasMusic || Boolean(musicAssetId) }),
    fingerprint: browserProjectFingerprint(inputProject, options.rippleEditing, options.visualSegments, options.runtimeProject),
    ...(focusTime === undefined ? {} : { focusTime: Math.min(focusTime, projectDuration(next, options)) }) };
}

export function restoreBrowserVisualMedia(segments, originals, origins, assets) {
  return restoreBrowserSegmentMedia(segments, originals, origins, assets);
}

export function restoreBrowserSegmentMedia(segments = [], originals = [], origins, assets = [], historyItems = []) {
  const sourceById = indexedSegments(originals);
  const nextById = indexedSegments(segments);
  const assetsById = assetMap(assets);
  if (origins === undefined && (sourceById.size !== nextById.size || segments.some((clip) => !sourceById.has(clip.id)))) reject("BROWSER_EDIT_STALE_PLAN");
  return segments.map((clip) => {
    const existing = sourceById.get(clip.id);
    const origin = origins && Object.hasOwn(origins, clip.id) ? origins[clip.id] : null;
    if (existing && origin && !MEDIA_REPLACEMENT_ORIGINS.has(origin.kind)) reject("BROWSER_EDIT_STALE_PLAN");
    const original = MEDIA_REPLACEMENT_ORIGINS.has(origin?.kind) ? origin.media : existing || (origin?.kind === "builtin-sticker" ? STICKER_LIBRARY.find(item => item.id === origin.id) : origin?.kind === "clip" ? sourceById.get(origin.id) : origin?.kind === "asset" ? assetsById.get(origin.id) : origin?.kind === "history" ? historyItems.find(item => item.id === origin.id) : null);
    if (!original) reject("BROWSER_EDIT_STALE_PLAN");
    if (existing && !MEDIA_REPLACEMENT_ORIGINS.has(origin?.kind) && clip.assetId !== undefined && clip.assetId !== existing.assetId) reject("BROWSER_EDIT_STALE_PLAN");
    const restored = { ...(existing || (origin?.kind === "clip" ? original : {})), ...clip };
    for (const key of MEDIA_FIELDS) {
      if (Object.hasOwn(original, key)) restored[key] = original[key];
      else delete restored[key];
    }
    if (MEDIA_REPLACEMENT_ORIGINS.has(origin?.kind)) {
      for (const key of ["voiceColorOriginalUrl", "voiceColorOriginalPeaks", "projectMedia"]) {
        if (Object.hasOwn(original, key)) restored[key] = original[key];
        else delete restored[key];
      }
    }
    // Audio waveforms are trimmed to the retained source range in the editor.
    // Preserve their mapping when a reviewed resize shortens that same source.
    const originalSourceStart = Number(original.sourceStart) || 0;
    const originalSourceDuration = Number(original.sourceDuration) || Number(original.duration) * (Number(original.playbackRate) || 1);
    const nextSourceStart = Number(clip.sourceStart) || 0;
    const nextSourceDuration = Number(clip.sourceDuration) || Number(clip.duration) * (Number(clip.playbackRate) || 1);
    if (Array.isArray(original.peaks) && originalSourceDuration > 0
      && (nextSourceStart !== originalSourceStart || nextSourceDuration < originalSourceDuration)
      && nextSourceStart >= originalSourceStart && nextSourceStart + nextSourceDuration <= originalSourceStart + originalSourceDuration + TIME_EPSILON) {
      const from = Math.floor(original.peaks.length * (nextSourceStart - originalSourceStart) / originalSourceDuration);
      const to = Math.max(from + 1, Math.ceil(original.peaks.length * (nextSourceStart - originalSourceStart + nextSourceDuration) / originalSourceDuration));
      restored.peaks = original.peaks.slice(from, to);
    }
    if (!existing) {
      restored.assetId = original.assetId || (origin.kind === "asset" ? origin.id : "");
      restored.archiveMediaId = origin.kind === "asset" ? clip.id : original.archiveMediaId || original.id;
      if (!restored.url && original.src && original.type === "audio") restored.url = original.src;
      if (!restored.src && original.url && original.type !== "audio") restored.src = original.url;
    }
    if ((restored.kind === "vector" || restored.vectorBody) && (clip.vectorBody !== original.vectorBody || JSON.stringify(clip.vectorDesign) !== JSON.stringify(original.vectorDesign))) {
      Object.assign(restored, buildVectorDesignPatch(restored, clip.vectorDesign));
    }
    const enhancedAssetId = clip.enhancement?.processed?.assetId;
    if (enhancedAssetId && enhancedAssetId !== original.enhancement?.processed?.assetId) {
      const asset = assetsById.get(enhancedAssetId);
      if (!asset?.src || !(asset.blob instanceof Blob)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      restored.enhancement = { ...clip.enhancement,
        original: original.enhancement?.original || Object.fromEntries(["src", "blob", "width", "height", "sourceStart", "sourceDuration", "trackFrames"].map(key => [key, original[key]])),
        processed: { ...clip.enhancement.processed, src: asset.src, blob: asset.blob, trackFrames: asset.trackFrames ?? [] },
      };
    }
    if (clip.enhancement && restored.enhancement && (enhancedAssetId || clip.enhancement.enabled !== original.enhancement?.enabled)) {
      const source = clip.enhancement.enabled ? restored.enhancement.processed : restored.enhancement.original;
      if (!source?.src) reject("BROWSER_EDIT_INVALID_PLAN");
      for (const key of ["src", "blob", "width", "height", "sourceStart", "sourceDuration"]) restored[key] = source[key];
      restored.trackFrames = source.trackFrames ?? [];
      restored.enhancement = { ...restored.enhancement, enabled: clip.enhancement.enabled };
    }
    const repairedAssetId = clip.repair?.processed?.assetId;
    if (repairedAssetId && (repairedAssetId !== original.repair?.processed?.assetId
      || clip.repair.regions && JSON.stringify(clip.repair.regions) !== JSON.stringify(original.repair?.regions))) {
      const asset = assetsById.get(repairedAssetId);
      if (!asset?.src || !(asset.blob instanceof Blob)) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      restored.repair = { ...clip.repair,
        original: original.repair?.original || Object.fromEntries(["src", "blob", "width", "height", "sourceStart", "sourceDuration", "trackFrames"].map(key => [key, original[key]])),
        processed: { ...clip.repair.processed, src: asset.src, blob: asset.blob, trackFrames: asset.trackFrames ?? [] },
      };
    } else if (original.repair) restored.repair = original.repair;
    if (restored.repair) {
      if (clip.repair && (repairedAssetId || clip.repair.enabled !== original.repair?.enabled)) {
        const source = clip.repair.enabled ? restored.repair.processed : restored.repair.original;
        if (!source?.src || !(source.blob instanceof Blob)) reject("BROWSER_EDIT_INVALID_PLAN");
        for (const key of ["src", "blob", "width", "height", "sourceStart", "sourceDuration"]) {
          if (source[key] !== undefined) restored[key] = source[key];
          else delete restored[key];
        }
        restored.trackFrames = source.trackFrames ?? [];
        restored.repair = { ...restored.repair, enabled: clip.repair.enabled };
      }
    }
    const cutoutAssetId = clip.vision?.cutoutAssetId;
    if (cutoutAssetId && cutoutAssetId !== original.vision?.cutoutAssetId) {
      const asset = assetsById.get(cutoutAssetId);
      if (asset?.type !== "image" || !asset.src || !(asset.blob instanceof Blob) || !asset.blob.size) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      restored.vision = { ...clip.vision, cutoutUrl: asset.src };
    }
    const background = clip.subjectEffect?.background;
    if (["image", "video"].includes(background?.mode) && background.assetId
      && (background.assetId !== original.subjectEffect?.background?.assetId || !background.src)) {
      const asset = assetsById.get(background.assetId);
      if (asset?.type !== background.mode || !(asset.blob instanceof Blob) || !asset.blob.size || !(asset.src || asset.url)) {
        reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
      }
      restored.subjectEffect = { ...clip.subjectEffect,
        background: { ...background, src: asset.src || asset.url } };
    }
    return restored;
  });
}

// Cross-track media origins resolve against the entire original snapshot. The
// returned music/source fields preserve runtime state unless a new music asset
// was explicitly selected; no object URLs are created during pure review.
export function restoreBrowserProjectMedia(next, runtimeProject, origins = {}, assets = [], historyItems = []) {
  const originals = MEDIA_COLLECTIONS.flatMap((key) => runtimeProject[key] || []);
  const restored = { ...runtimeProject, ...next };
  for (const key of MEDIA_COLLECTIONS) restored[key] = restoreBrowserSegmentMedia(next[key] || [], originals, origins, assets, historyItems);
  restored.musicSegments = restored.musicSegments.map(({ blob: _blob, src: _src, url: _url, originalBlob: _originalBlob,
    compatibilityAudioBlob: _compatibilityAudioBlob, voiceColorOriginalBlob: _voiceColorOriginalBlob, ...clip }) => clip);
  const musicAssetIds = new Set((next.musicSegments || []).flatMap((clip) => {
    const origin = Object.hasOwn(origins, clip.id) ? origins[clip.id] : null;
    return origin?.kind === "asset" ? [origin.id] : [];
  }));
  if (musicAssetIds.size > 1) reject("BROWSER_EDIT_MULTIPLE_MUSIC_SOURCES");
  if (musicAssetIds.size) {
    const asset = assetMap(assets).get([...musicAssetIds][0]);
    if (!asset?.blob) reject("BROWSER_EDIT_ASSET_UNAVAILABLE");
    restored.musicBlob = asset.blob;
    restored.musicUrl = asset.url || asset.src || "";
    restored.musicPeaks = asset.peaks || [];
  } else if ((runtimeProject.musicSegments || []).length && !next.musicSegments?.length && Number(next.musicDuration) === 0) {
    restored.musicBlob = null;
    restored.musicUrl = "";
    restored.musicPeaks = [];
  }
  return restored;
}
