import { CAPTION_STYLE_PROPERTY_SCHEMA, VISUAL_KEYFRAME_PROPERTY_SCHEMA, VISUAL_MASK_PROPERTY_SCHEMA, SUBJECT_EFFECT_PROPERTY_SCHEMA, CLICK_RIPPLE_PROPERTY_SCHEMA, CINEMATIC_DEPTH_PROPERTY_SCHEMA, PHOTO_PARALLAX_PROPERTY_SCHEMA, VECTOR_DESIGN_PROPERTY_SCHEMA } from "./projectCommandEngine.js";
import { normalizeColorGrade } from "./colorGrade.js";
import { createEditableVectorDocument } from "./vectorDocument.js";
import { buildVectorDesignPatch } from "./vectorDesign.js";

const COLLECTIONS = {
  visuals: "visualSegments", overlays: "visualOverlaySegments", audio: "audioSegments",
  captions: "captionSegments", stickers: "stickerSegments", music: "musicSegments",
};
const FIELDS = [
  "id", "type", "name", "text", "start", "end", "duration", "sourceStart", "sourceDuration",
  "playbackRate", "volume", "fadeIn", "fadeOut", "muted", "layer", "lane", "hidden", "audioSegmentId",
  "sourceAudioDisabled", "sourceAudioUnmapped", "sourceAudioVolume", "audioSeparated",
  "detachedAudioSegmentId", "x", "y", "scale", "rotation", "opacity", "fontId",
  "spatialEffect", "spatialAmount", "reversed",
  "filterId", "stickerId",
];
const GLOBAL_FIELDS = ["script", "ratioId", "fitMode", "musicName", "musicDuration", "musicStart", "musicVolume", "sourceAudioStart", "sourceAudioVolume", "sourceAudioSpatialEffect", "sourceAudioSpatialAmount", "captionsEnabled", "trackVisibility", "trackLocks", "captionStyle", "captionSize", "captionStylePresetId", "captionStylePresets", "captionPlacement", "captionPosition"];
const NESTED_FIELDS = { vectorDesign: Object.keys(VECTOR_DESIGN_PROPERTY_SCHEMA), baseTransform: ["x", "y", "scale", "rotation", "opacity"], placement: ["x", "y"], styleOverrides: Object.keys(CAPTION_STYLE_PROPERTY_SCHEMA), transition: ["id", "duration"], mask: Object.keys(VISUAL_MASK_PROPERTY_SCHEMA), clickRipple: [...Object.keys(CLICK_RIPPLE_PROPERTY_SCHEMA), "interval"] };
const scalar = (value) => ["string", "boolean", "number"].includes(typeof value) || value === null;
const pick = (value, fields) => Object.fromEntries(fields.filter((key) => Object.hasOwn(value || {}, key) && scalar(value[key])).map((key) => [key, value[key]]));

export function browserClipProperties(clip) {
  return { ...pick(clip, FIELDS), ...Object.fromEntries(Object.entries(NESTED_FIELDS).filter(([key]) => clip?.[key]).map(([key, fields]) => [key, pick(clip[key], fields)])),
    ...(clip?.kind === "vector" || clip?.vectorBody ? { vectorParts: createEditableVectorDocument(buildVectorDesignPatch(clip, clip.vectorDesign).vectorBody).parts } : {}),
    ...(Array.isArray(clip?.keyframes) ? { keyframes: clip.keyframes.map(frame => pick(frame, ["time", ...Object.keys(VISUAL_KEYFRAME_PROPERTY_SCHEMA)])) } : {}),
    ...(clip?.speedCurve ? { speedCurve: { ...pick(clip.speedCurve, ["enabled", "smooth"]), points: (clip.speedCurve.points || []).map(point => pick(point, ["progress", "rate", "easingRange"])) } } : {}),
    ...(clip?.colorGrade ? { colorGrade: normalizeColorGrade(clip.colorGrade) } : {}),
    ...(clip?.repair ? { repair: { ...pick(clip.repair, ["mode", "enabled", "backend", "frameRate", "totalFrames"]),
      ...(Array.isArray(clip.repair.regions) ? { regions: clip.repair.regions.map(region => ({ ...pick(region, ["id", "start", "end"]),
        selection: pick(region.selection, ["x", "y", "width", "height"]),
        keyframes: (region.keyframes || []).map(frame => ({ ...pick(frame, ["time"]), selection: pick(frame.selection, ["x", "y", "width", "height"]) })),
      })) } : {}),
    } } : {}),
    ...(clip?.enhancement ? { enhancement: { ...pick(clip.enhancement, ["mode", "enabled", "preset", "strength", "backend", "pipeline", "frameRate", "totalFrames", "reusedFrames", "audioPreserved"]),
      ...(clip.enhancement.analysis ? { analysis: pick(clip.enhancement.analysis, ["score", "strength"]) } : {}),
      ...(clip.enhancement.processed ? { processed: {
        ...pick(clip.enhancement.processed, ["name", "width", "height", "sourceDuration"]),
        ...(typeof clip.enhancement.processed.assetId === "string" ? { id: clip.enhancement.processed.assetId } : {}),
      } } : {}),
    } } : {}),
    ...(clip?.depth ? { depth: { complete: clip.depth.complete === true, sampleCount: clip.depth.samples?.length || 0,
      duration: clip.depth.duration, fps: clip.depth.fps, model: clip.depth.model, analyzedAt: clip.depth.analyzedAt } } : {}),
    ...(clip?.vision ? { vision: { ...pick(clip.vision, ["kind", "complete", "visualType", "sourceAssetId", "cutoutAssetId"]),
      ...(clip.vision.sourceSize ? { sourceSize: pick(clip.vision.sourceSize, ["width", "height"]) } : {}),
      options: pick(clip.vision.options, ["removeBackground", "avoidCaptions"]) } } : {}),
    ...(clip?.smartFrame ? { smartFrame: { ...pick(clip.smartFrame, ["version", "enabled", "targetRatio", "presentation"]),
      settings: pick(clip.smartFrame.settings, ["motion", "padding", "maxZoom"]),
      stats: pick(clip.smartFrame.stats, ["sampleCount", "anchorCount", "flowCount", "lostCount", "runtimeBackend", "analysisMs"]),
      pathPoints: Array.isArray(clip.smartFrame.cropKeyframes) ? clip.smartFrame.cropKeyframes.length : 0 } } : {}),
    ...Object.fromEntries([["subjectEffect", SUBJECT_EFFECT_PROPERTY_SCHEMA], ["cinematicDepth", CINEMATIC_DEPTH_PROPERTY_SCHEMA],
      ["photoParallax", PHOTO_PARALLAX_PROPERTY_SCHEMA]].filter(([field]) => clip?.[field]).map(([field, schema]) => [field, Object.fromEntries(Object.keys(schema).flatMap(property => {
      const [key, child] = property.split(".");
      const value = child ? clip[field][key]?.[child] : clip[field][key];
      return value !== undefined && scalar(value) ? [[property, value]] : [];
    }))])),
    ...(["image", "video"].includes(clip?.subjectEffect?.background?.mode) && clip.subjectEffect.background.assetId
      ? { subjectBackground: pick(clip.subjectEffect.background, ["mode", "assetId", "fit", "opacity"]) } : {}),
    ...(clip?.animation ? { animation: Object.fromEntries(["in", "out"].map(phase => [phase, pick(clip.animation[phase], ["id", "duration"])])) } : {}) };
}

export function browserReviewEntities(project) {
  return Object.fromEntries(Object.entries(COLLECTIONS).map(([track, key]) => [track, (project[key] || []).map(browserClipProperties)]));
}

export function browserAssetSummary(asset) {
  const hasMedia = asset?.blob instanceof Blob && asset.blob.size > 0;
  const validType = ["image", "video", "audio"].includes(asset?.type);
  const ready = hasMedia && validType && !asset.preparing && asset.prepareStage !== "failed" && (asset.type === "image" || Number(asset.duration) > 0);
  return {
    assetId: String(asset.assetId || asset.id || ""), type: asset.type,
    name: String(asset.name || ""), duration: Math.max(0, Number(asset.duration) || (asset.type === "image" ? 4 : 0)),
    width: Math.max(0, Number(asset.width) || 0), height: Math.max(0, Number(asset.height) || 0),
    kind: asset.kind || "", bytes: hasMedia ? asset.blob.size : 0,
    status: asset.prepareStage === "failed" ? "unavailable" : asset.preparing || (hasMedia && asset.type !== "image" && !Number(asset.duration)) ? "preparing" : ready ? "ready" : "unavailable",
    insertableTracks: !ready ? [] : asset.type !== "audio" ? ["visuals", "overlays"] : asset.kind === "music" ? ["music"] : ["audio", "music"],
  };
}

// A semantic diff may contain internal media metadata. Browser results only
// expose the fields the public edit contract can change or help review.
export function browserReviewDiff(diff) {
  const result = { ...diff };
  result.tracks = Object.fromEntries(Object.entries(diff.tracks || {}).map(([track, changes]) => [track, {
    ...changes,
    modified: (changes.modified || []).map((item) => {
      const fields = (item.fields || []).filter((field) => FIELDS.includes(field) || Object.hasOwn(NESTED_FIELDS, field) || ["keyframes", "speedCurve", "enhancement", "repair", "colorGrade", "animation", "subjectEffect", "cinematicDepth", "photoParallax", "depth", "vision", "smartFrame", "vectorBody"].includes(field)).map(field => field === "vectorBody" ? "vectorParts" : field);
      const values = (source) => {
        const safe = browserClipProperties(source);
        return Object.fromEntries(fields.map(field => [field, safe[field] ?? null]));
      };
      return { id: item.id, fields, before: values(item.before), after: values(item.after) };
    }),
  }]));
  if (Array.isArray(diff.projectFields)) result.projectFields = diff.projectFields.filter((entry) => GLOBAL_FIELDS.includes(entry.field)).map((entry) => {
    if (entry.field === "captionStylePresets") {
      const presets = items => Array.isArray(items) ? items.map(item => ({ ...pick(item, ["id", "name", "captionSize"]), style: pick(item.style || {}, Object.keys(CAPTION_STYLE_PROPERTY_SCHEMA)) })) : null;
      return { ...entry, before: presets(entry.before), after: presets(entry.after) };
    }
    const nested = entry.field === "captionStyle" ? Object.keys(CAPTION_STYLE_PROPERTY_SCHEMA) : entry.field === "captionPlacement" ? ["x", "y"] : null;
    return nested ? { ...entry, before: entry.before ? pick(entry.before, nested) : null, after: entry.after ? pick(entry.after, nested) : null } : entry;
  });
  return result;
}
