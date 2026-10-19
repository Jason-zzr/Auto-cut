import { MAX_TIMELINE_DURATION_SECONDS, MIN_VISUAL_SEGMENT_SECONDS, FILTER_OPTIONS, STICKER_LIBRARY } from "../config/editor.js";
import { MAX_TIMELINE_MARKER_SECONDS, TIMELINE_MARKER_COLORS, TIMELINE_MARKER_TYPES } from "./timelineMarkers.js";
import { CAPTION_STYLE_PROPERTY_SCHEMA, VISUAL_KEYFRAME_PROPERTY_SCHEMA, VISUAL_MASK_PROPERTY_SCHEMA, SUBJECT_EFFECT_PROPERTY_SCHEMA, CLICK_RIPPLE_PROPERTY_SCHEMA, CINEMATIC_DEPTH_PROPERTY_SCHEMA, PHOTO_PARALLAX_PROPERTY_SCHEMA, STICKER_TRANSFORM_PROPERTY_SCHEMA, VECTOR_DESIGN_PROPERTY_SCHEMA } from "./projectCommandEngine.js";
import { COLOR_GRADE_KEYFRAME_KEYS } from "./colorGrade.js";
import { VISUAL_CLIP_ANIMATION_OPTIONS } from "./visualClipAnimations.js";
import { MAX_SRT_FILE_BYTES } from "./subtitles.js";
import { AUDIO_SPATIAL_EFFECTS } from "./audioSpatialEffects.js";
import { ENHANCEMENT_PROCESSING_PROPERTIES } from "./projectCommandEngine.js";
import { MIGAN_REGIONS_SCHEMA } from "./miganRepairRegions.js";
import { DEPTH_ANALYSIS_SCHEMA } from "./depthOfField.js";
import { VECTOR_PART_PROPERTY_SCHEMA } from "./projectCommandEngine.js";

const id = { type: "string", minLength: 1, maxLength: 256 };
const time = { type: "number", minimum: 0, maximum: MAX_TIMELINE_DURATION_SECONDS };
const sourceTime = { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const duration = { ...time, minimum: MIN_VISUAL_SEGMENT_SECONDS };
const index = { type: "integer", minimum: 0, maximum: 500 };
const layer = { type: "integer", minimum: 1, maximum: 1000 };
const muted = { type: "boolean" };
const timedTrack = { type: "string", enum: ["audio", "music", "overlays", "stickers"] };
const scope = { type: "string", enum: ["default", "current"] };
const captionScopeRule = { if: { properties: { scope: { const: "current" } } }, then: { required: ["clipId"] }, else: { not: { required: ["clipId"] } } };
const transform = {
  type: "object", additionalProperties: false,
  properties: {
    x: { type: "number", minimum: -1000, maximum: 1000 },
    y: { type: "number", minimum: -1000, maximum: 1000 },
    scale: { type: "number", minimum: 0.1, maximum: 20 },
    rotation: { type: "number", minimum: -36000, maximum: 36000 },
    opacity: { type: "number", minimum: 0, maximum: 1 },
  },
};
const marker = {
  markerId: { ...id, maxLength: 160 },
  markerType: { type: "string", enum: [...TIMELINE_MARKER_TYPES] },
  time: { type: "number", minimum: 0, maximum: MAX_TIMELINE_MARKER_SECONDS },
  endTime: { type: "number", minimum: 0, maximum: MAX_TIMELINE_MARKER_SECONDS },
  title: { type: "string", maxLength: 240 },
  notes: { type: "string", maxLength: 20000 },
  color: { type: "string", enum: [...TIMELINE_MARKER_COLORS] },
};
const operation = (type, properties, required) => ({
  type: "object", additionalProperties: false,
  properties: { type: { const: type }, ...properties }, required: ["type", ...required],
});

// Public browser inputs contain references and edit parameters, never runtime
// media, filesystem paths, URLs, reducer payloads, or arbitrary JavaScript.
export const WEB_MCP_OPERATION_SCHEMA = {
  oneOf: [
    { ...operation("audio.apply_reverse", { clipId: id, assetId: id, reversed: { type: "boolean" } }, ["clipId", "assetId", "reversed"]), description: "Apply an existing prepared reversed or restored audio asset to an audio clip through review. Preserves timing, settings and the first original source for restoration. Does not reverse samples or generate media itself." },
    { ...operation("audio.replace_source", { clipId: id, assetId: id }, ["clipId", "assetId"]), description: "Replace an exact audio clip's source with an existing prepared audio asset through review. Keeps the clip ID, timeline range, lane, captions and mix settings; resets source timing to the prepared result and retains the previous media in normal undo." },
    { ...operation("source.apply_voice_color", { assetId: id, profileName: id }, ["assetId", "profileName"]), description: "Review replacement of the unlinked source-audio track with an existing converted audio asset. Preserves timing and the first original audio. No inference." },
    { ...operation("source.restore_voice_color", {}, []), description: "Review restoration of the unlinked source-audio track's retained original voice-color media. Requires a retained original." },
    { ...operation("audio.apply_voice_color", { clipId: id, assetId: id, profileName: id }, ["clipId", "assetId", "profileName"]), description: "Review replacement of an audio clip's source with an existing converted audio asset. Preserves timing and the first original audio for restoration; does not infer, remove library assets or revoke undo media." },
    { ...operation("audio.restore_voice_color", { clipId: id }, ["clipId"]), description: "Review restoration of an audio clip's retained original voice-color media. Preserves timing and library assets. Requires a retained original." },
    { ...operation("voice.remove_history", { historyId: id }, ["historyId"]), description: "Remove an exact current-session voice history record through reviewed application and normal undo. Keeps audio already used on the timeline and library assets. Does not purge media files." },
    { ...operation("voice.restore_history", { historyId: id, clipId: id, start: time }, ["historyId", "clipId", "start"]), description: "Restore an exact current-session voice history record: append its audio at start, preserve existing audio, and replace the entire script/caption set using the original history behavior. Use alone in a reviewed transaction. No synthesis. Read timeline_voice_history first." },
    { ...operation("track.clear_music", {}, []), description: "Remove the shared background music and all its clips in the reviewed transaction, retaining library assets and undo media. Requires an unlocked music track. Do not combine with later music edits in the same preview." },
    { ...operation("track.clear_source_audio", {}, []), description: "Remove the shared source-audio track through reviewed application. Keeps visual clips and library assets. Track locks apply; undo retains the original media." },
    { ...operation("source.replace_audio", { assetId: id }, ["assetId"]), description: "Replace the current shared source-audio media with an existing prepared audio asset through review. Keeps source-track timing, linked visual mapping, volume and spatial settings; normal undo retains the previous media." },
    { ...operation("track.replace_music", { assetId: id, clipId: id, start: time, duration }, ["assetId", "clipId", "start", "duration"]), description: "Replace the shared music source and its timeline clips with one prepared audio asset at the requested time. This matches the original music replacement behavior and is undoable." },
    { ...operation("asset.remove_from_library", { assetId: id }, ["assetId"]), description: "Remove an exact My assets entry in the reviewed transaction. Keeps existing timeline clips and their media, other library entries and undo media. To also remove clips, include explicit visual.delete or clip.delete operations in the same preview after inspecting asset references. Does not purge project files." },
    operation("caption.add", { clipId: id, text: { type: "string", maxLength: 20000 }, start: time, end: time, audioClipId: id, visualClipId: id }, ["clipId", "text", "start", "end"]),
    operation("caption.update", { clipId: id, text: { type: "string", maxLength: 20000 }, start: time, end: time, hidden: { type: "boolean", description: "Set this caption's hidden state without deleting its text, timing or links. false restores it subject to the existing global caption/track visibility settings." } }, ["clipId"]),
    operation("caption.delete", { clipId: id }, ["clipId"]),
    operation("caption.import_srt", { text: { type: "string", minLength: 1, maxLength: MAX_SRT_FILE_BYTES }, mode: { type: "string", enum: ["append", "replace"] } }, ["text", "mode"]),
    operation("caption.set_enabled", { enabled: { type: "boolean" } }, ["enabled"]),
    {
      ...operation("caption.save_preset", { scope, clipId: id, name: { type: "string", minLength: 1, maxLength: 240 } }, ["scope", "name"]),
      allOf: [captionScopeRule],
    },
    {
      ...operation("caption.apply_preset", { scope, clipId: id, presetId: id }, ["scope", "presetId"]),
      allOf: [captionScopeRule],
    },
    {
      ...operation("caption.set_style", { scope, clipId: id, style: { type: "object", additionalProperties: false, minProperties: 1, properties: CAPTION_STYLE_PROPERTY_SCHEMA } }, ["scope", "style"]),
      allOf: [captionScopeRule],
    },
    {
      ...operation("caption.set_position", { scope, clipId: id, placement: {
        type: "object", additionalProperties: false, properties: { x: { type: "number", minimum: 10, maximum: 90 }, y: { type: "number", minimum: 10, maximum: 90 } }, required: ["x", "y"],
      } }, ["scope", "placement"]),
      allOf: [captionScopeRule],
    },
    operation("caption.sync_position", { clipId: id }, ["clipId"]),
    operation("caption.reset_overrides", { clipId: id, property: { type: "string", enum: ["placement", ...Object.keys(CAPTION_STYLE_PROPERTY_SCHEMA)] } }, ["clipId"]),
    operation("caption.unlink_audio", { clipId: id }, ["clipId"]),
    { ...operation("caption.link_audio", { clipId: id, audioClipId: id, align: { type: "boolean" } }, ["clipId"]), description: "Link a caption to an exact audio clip. If audioClipId is omitted, uses the remembered detachedAudioSegmentId, not an automatic nearest match. align=true also sets caption start/end to the full audio interval; otherwise timing is retained. To align already linked captions, inspect their audioSegmentId and supply it explicitly. Multiple captions can be aligned in one reviewed plan using one operation per caption." },
    operation("transition.set", { clipId: id, transitionId: { type: "string", enum: ["none", "fade", "zoom", "flash", "wipe-left", "wipe-up", "blur", "split", "glitch"] }, duration: { type: "number", exclusiveMinimum: 0, maximum: 2 } }, ["clipId", "transitionId"]),
    { ...operation("track.set_visibility", { track: { type: "string", enum: ["visuals", "captions", "audio", "stickers", "overlays", "source", "music"] }, visible: { type: "boolean" }, clipId: id }, ["track", "visible"]), description: "Set whole-track visibility. For audio only, optional clipId targets the current lane containing that exact audio clip, affecting every clip on that lane. Other lanes and the whole-track setting remain unchanged. A hidden whole audio track still overrides lane visibility." },
    operation("source.set_volume", { clipId: id, volume: { type: "number", minimum: 0, maximum: 4 } }, ["clipId", "volume"]),
    { ...operation("track.set_locked", { track: { type: "string", enum: ["visuals", "captions", "audio", "stickers", "overlays", "source", "music"] }, locked: { type: "boolean" }, clipId: id }, ["track", "locked"]), description: "Set whole-track lock. For audio only, optional clipId targets the current lane containing that exact audio clip, affecting every clip on that lane. Other lanes and the whole-track lock remain unchanged. A locked whole audio track still overrides an unlocked lane." },
    operation("track.set_source_audio", { settings: { type: "object", additionalProperties: false, minProperties: 1, properties: {
      volume: { type: "number", minimum: 0, maximum: 4 },
      spatialEffect: { type: "string", enum: AUDIO_SPATIAL_EFFECTS.map(effect => effect.id) },
      spatialAmount: { type: "number", minimum: 0, maximum: 1 },
    } } }, ["settings"]),
    operation("timed.move", { track: timedTrack, clipId: id, start: time, layer }, ["track", "clipId", "start"]),
    { ...operation("caption.duplicate", { clipId: id, newClipId: id }, ["clipId", "newClipId"]), description: "Duplicate a caption immediately after it in caption order, retaining its timing, audio/visual links, style and placement. Matches manual copy text suffix and inherited font. Use caption.update on the new ID in the same plan to change text or absolute start/end." },
    { ...operation("timed.duplicate", { track: { type: "string", enum: ["audio", "music", "overlays", "stickers"] }, clipId: id, newClipId: id, start: time, captionCopies: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false, properties: { clipId: id, newClipId: id }, required: ["clipId", "newClipId"] } } }, ["track", "clipId", "newClipId"]), description: "Duplicate audio, music, overlay or sticker with a new ID, retaining source media and properties. Optional start is absolute timeline seconds. Default matches manual duplication: music/sticker follows the source end by 0.2 seconds; audio/overlay follows its start by 0.2 seconds. Overlay uses a new layer. Audio requires one captionCopies entry for every linked caption, with its current clipId and a unique newClipId; copies retain text/style and shift with the audio. Default start is clamped to the timeline limit." },
    { ...operation("timed.split", { track: { type: "string", enum: ["audio", "music", "overlays", "stickers"] }, clipId: id, rightClipId: id, at: time }, ["track", "clipId", "rightClipId", "at"]), description: "Split audio/music/overlays/stickers at absolute timeline seconds. Audio/music must leave more than 0.05 seconds on each side; stickers more than 0.35 seconds; overlays use the editor minimum visual duration. Sticker appearance is preserved on both halves. Left retains clipId; right uses a new ID. Preserves constant source playback rate. Overlay transform keyframes remain continuous at the cut. Audio/music preserve outer fades and clear inner fades. Split crossing linked captions first with caption.split; right-side captions follow the right audio clip. Speed curves and reversed sources are unsupported." },
    operation("timed.resize", { track: timedTrack, clipId: id, start: time, duration }, ["track", "clipId", "duration"]),
    operation("timed.trim", { track: { type: "string", enum: ["audio", "music", "overlays"] }, clipId: id, sourceIn: sourceTime, sourceOut: sourceTime }, ["track", "clipId", "sourceIn", "sourceOut"]),
    operation("clip.delete", { track: timedTrack, clipId: id }, ["track", "clipId"]),
    operation("overlay.set_transform", { clipId: id, transform: { ...transform, minProperties: 1 } }, ["clipId", "transform"]),
    operation("visual.set_transform", { clipId: id, transform: { ...transform, minProperties: 1 } }, ["clipId", "transform"]),
    operation("sticker.set_transform", { clipId: id, transform: { type: "object", additionalProperties: false, minProperties: 1, properties: STICKER_TRANSFORM_PROPERTY_SCHEMA } }, ["clipId", "transform"]),
    { ...operation("caption.split", { clipId: id, rightClipId: id, at: time }, ["clipId", "rightClipId", "at"]), description: "Split a caption at absolute timeline seconds, leaving more than 0.2 seconds on each side. Matches the manual cut: both halves retain full text and other properties. Left retains clipId, right uses the new rightClipId. Use caption.update separately to revise text." },
    { ...operation("sticker.add", { clipId: id, stickerId: { type: "string", oneOf: STICKER_LIBRARY.map(item => ({ const: item.id, title: `${item.name} / ${item.nameEn}` })) }, start: time, duration,
      transform: { type: "object", additionalProperties: false, minProperties: 1, properties: STICKER_TRANSFORM_PROPERTY_SCHEMA } }, ["clipId", "stickerId", "start"]), description: "Insert an original built-in sticker with a new clip ID. Duration defaults to 3 seconds. Preview and apply as one undoable edit." },
    operation("clip.set_vector_design", { clipId: id, design: { type: "object", additionalProperties: false, minProperties: 1, properties: VECTOR_DESIGN_PROPERTY_SCHEMA } }, ["clipId", "design"]),
    { ...operation("clip.set_vector_part", { clipId: id, partId: id, patch: { type: "object", additionalProperties: false, minProperties: 1, properties: VECTOR_PART_PROPERTY_SCHEMA } }, ["clipId", "partId", "patch"]), description: "Edit a specific SVG part using vectorParts IDs and supported properties from clip inspection; preview before applying." },
    operation("project.set_ratio", { ratio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5"] } }, ["ratio"]),
    operation("project.set_fit", { fitMode: { type: "string", enum: ["contain", "cover"] } }, ["fitMode"]),
    {
      ...operation("clip.set_property", { clipId: id, property: { type: "string", enum: ["volume", "fadeIn", "fadeOut"] }, value: { type: "number", minimum: 0, maximum: 1800 } }, ["clipId", "property", "value"]),
      allOf: [{ if: { properties: { property: { const: "volume" } } }, then: { properties: { value: { type: "number", maximum: 4 } } } }],
    },
    { ...operation("clip.set_speed", { clipId: id, speed: { type: "number", minimum: 0.25, maximum: 4 } }, ["clipId", "speed"]), description: "Set constant playback speed. For video, reuses the original editor behavior: disables the speed curve, retimes existing keyframes and retains transitions. Linked captions keep their source-time alignment." },
    operation("clip.set_speed_curve", { clipId: id, curve: {
      type: "object", additionalProperties: false, required: ["smooth", "points"],
      properties: { smooth: { type: "boolean" }, points: {
        type: "array", minItems: 2, maxItems: 8,
        description: "Ordered nodes from progress 0 to 1, at least 0.005 apart. Reset with all rates equal to 1. Reuses the editor speed curve and retimes keyframes.",
        items: { type: "object", additionalProperties: false, required: ["progress", "rate"], properties: {
          progress: { type: "number", minimum: 0, maximum: 1 }, rate: { type: "number", minimum: 0.25, maximum: 4 },
        } },
      } },
    } }, ["clipId", "curve"]),
    operation("clip.set_muted", { clipId: id, muted }, ["clipId", "muted"]),
    operation("clip.set_enhancement_enabled", { clipId: id, enabled: { type: "boolean" } }, ["clipId", "enabled"]),
    operation("clip.set_repair_enabled", { clipId: id, enabled: { type: "boolean" } }, ["clipId", "enabled"]),
    operation("clip.apply_repair", { clipId: id, assetId: id, regions: MIGAN_REGIONS_SCHEMA }, ["clipId", "assetId", "regions"]),
    { ...operation("clip.apply_vision_cutout", { clipId: id, sourceAssetId: id, assetId: id }, ["clipId", "sourceAssetId", "assetId"]),
      description: "Attach an existing generated transparent image to the exact source image clip through review and undo. This does not run inference, select a subject or change the clip's timing, transform or background effect settings." },
    { ...operation("clip.set_subject_background_media", { clipId: id, assetId: id,
      fitMode: { type: "string", enum: ["cover", "contain"] }, opacity: { type: "number", minimum: 0, maximum: 1 } }, ["clipId", "assetId"]),
      description: "Bind an existing ready image or video asset as the subject background of an exact visual clip through review and undo. The clip must already have reusable cutout masks. fitMode defaults to cover and opacity defaults to 1." },
    { ...operation("clip.apply_caption_avoidance", { clipId: id, sourceAssetId: id,
      analysis: { type: "object", description: "Normalized subject path returned by a successful caption_avoidance job. Use that result unchanged." } }, ["clipId", "sourceAssetId", "analysis"]),
      description: "Attach completed subject analysis and enable caption avoidance on its exact visual clip through review and undo. Run caption_avoidance to produce the analysis; ordinary edits cannot run detection." },
    { ...operation("clip.set_caption_avoidance", { clipId: id, enabled: { type: "boolean" } }, ["clipId", "enabled"]),
      description: "Enable or disable caption avoidance on a visual clip that already has attached subject analysis. Keeps media, timing, transforms and captions unchanged." },
    { ...operation("clip.apply_smart_frame", { clipId: id, sourceAssetId: id,
      smartFrame: { type: "object", description: "Normalized Smart Frame analysis returned by a successful smart_frame job. Use that result unchanged." } }, ["clipId", "sourceAssetId", "smartFrame"]),
      description: "Attach a completed Smart Frame analysis to its exact source clip through review and undo. Run smart_frame to produce the normalized analysis; ordinary edit calls cannot run subject detection." },
    { ...operation("clip.remove_smart_frame", { clipId: id }, ["clipId"]),
      description: "Remove the existing Smart Frame crop path from the exact visual clip through review and undo. Keeps the clip, source media, timing and project ratio." },
    { ...operation("clip.apply_depth_analysis", { clipId: id, sourceAssetId: id, analysis: DEPTH_ANALYSIS_SCHEMA }, ["clipId", "sourceAssetId", "analysis"]),
      description: "Attach completed native depth analysis to the exact source clip through review and undo. Configure cinematic depth, relighting or photo parallax with their existing property operations." },
    operation("clip.apply_enhancement", { clipId: id, assetId: id, mode: { type: "string", enum: ["smart-denoise-drunet", "nanovsr-644k", "remaster-drunet-full"] },
      processing: { anyOf: [{ type: "object", additionalProperties: false, required: ["backend"], properties: {
        backend: { type: "string", maxLength: 256 }, frameRate: { type: "integer", minimum: 1, maximum: 15 }, totalFrames: { type: "integer", minimum: 1 },
      } }, { type: "object", additionalProperties: false, required: [...Object.keys(ENHANCEMENT_PROCESSING_PROPERTIES), "analysis"],
        properties: { ...ENHANCEMENT_PROCESSING_PROPERTIES, analysis: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["score", "strength"], properties: { score: { type: "number", minimum: 0, maximum: 1 }, strength: { type: "number", minimum: 0, maximum: 1 } } }] } } }] },
    }, ["clipId", "assetId", "mode"]),
    operation("clip.set_spatial", { clipId: id, effect: { type: "string", enum: AUDIO_SPATIAL_EFFECTS.map(preset => preset.id) }, amount: { type: "number", minimum: 0, maximum: 1 } }, ["clipId", "effect", "amount"]),
    {
      ...operation("clip.keyframe_set", { clipId: id, time, property: { type: "string", enum: Object.keys(VISUAL_KEYFRAME_PROPERTY_SCHEMA) }, value: { type: "number" } }, ["clipId", "time", "property", "value"]),
      allOf: Object.entries(VISUAL_KEYFRAME_PROPERTY_SCHEMA).map(([property, value]) => ({ if: { properties: { property: { const: property } } }, then: { properties: { value } } })),
    },
    operation("clip.keyframe_remove", { clipId: id, time, property: { type: "string", enum: Object.keys(VISUAL_KEYFRAME_PROPERTY_SCHEMA) } }, ["clipId", "time"]),
    operation("clip.set_filter", { clipId: id, filterId: { type: "string", enum: FILTER_OPTIONS.map(option => option.id) } }, ["clipId", "filterId"]),
    operation("clip.set_animation", { clipId: id, phase: { type: "string", enum: ["in", "out"] }, animationId: { type: "string", enum: VISUAL_CLIP_ANIMATION_OPTIONS.map(option => option.id) }, duration: { type: "number", minimum: 0.1, maximum: 3 } }, ["clipId", "phase", "animationId", "duration"]),
    operation("clip.set_mask", { clipId: id, mask: { type: "object", additionalProperties: false, minProperties: 1, properties: VISUAL_MASK_PROPERTY_SCHEMA } }, ["clipId", "mask"]),
    ...[["clip.set_subject_effect", SUBJECT_EFFECT_PROPERTY_SCHEMA], ["clip.set_click_ripple", CLICK_RIPPLE_PROPERTY_SCHEMA],
      ["clip.set_cinematic_depth", CINEMATIC_DEPTH_PROPERTY_SCHEMA], ["clip.set_photo_parallax", PHOTO_PARALLAX_PROPERTY_SCHEMA]].map(([type, properties]) => ({
      ...operation(type, { clipId: id, property: { type: "string", enum: Object.keys(properties) }, value: { type: ["number", "string", "boolean"] } }, ["clipId", "property", "value"]),
      ...(["clip.set_cinematic_depth", "clip.set_photo_parallax"].includes(type) ? {
        description: "Configure existing effect parameters only. Rendering also requires depth analysis for this clip; this operation does not run analysis or generate media.",
      } : {}),
      allOf: Object.entries(properties).map(([property, value]) => ({ if: { properties: { property: { const: property } } }, then: { properties: { value } } })),
    })),
    {
      ...operation("clip.set_color_grade", { clipId: id, property: { type: "string", enum: COLOR_GRADE_KEYFRAME_KEYS }, value: { type: "number" } }, ["clipId", "property", "value"]),
      allOf: COLOR_GRADE_KEYFRAME_KEYS.map(property => ({ if: { properties: { property: { const: property } } }, then: { properties: { value: VISUAL_KEYFRAME_PROPERTY_SCHEMA[property] } } })),
    },
    operation("marker.add", marker, ["markerId", "time"]),
    operation("marker.update", marker, ["markerId"]),
    operation("marker.delete", { markerId: marker.markerId }, ["markerId"]),
    operation("visual.split", { clipId: id, at: { ...duration, description: "Seconds from this visual clip's start, not the absolute timeline position. Must be inside the clip." }, rightClipId: id }, ["clipId", "at", "rightClipId"]),
    operation("visual.delete", { clipId: id }, ["clipId"]),
    operation("visual.duplicate", { clipId: id, newClipId: id, atIndex: index }, ["clipId", "newClipId"]),
    operation("visual.reorder", { clipId: id, toIndex: index }, ["clipId", "toIndex"]),
    operation("visual.trim", { clipId: id, sourceIn: sourceTime, sourceOut: sourceTime }, ["clipId", "sourceIn", "sourceOut"]),
    {
      ...operation("visual.insert", { clipId: id, sourceClipId: id, assetId: id, atIndex: index, duration }, ["clipId", "atIndex"]),
      oneOf: [{ required: ["sourceClipId"] }, { required: ["assetId"] }],
    },
    {
      ...operation("overlay.add", { clipId: id, sourceClipId: id, assetId: id, start: time, duration, layer, muted, transform }, ["clipId", "start"]),
      oneOf: [{ required: ["sourceClipId"] }, { required: ["assetId"] }],
    },
    {
      ...operation("asset.insert", { assetId: id, clipId: id, track: { type: "string", enum: ["visuals", "overlays", "audio", "music"] }, atIndex: index, start: time, duration, layer, muted, transform }, ["assetId", "clipId", "track"]),
      allOf: [{ if: { properties: { track: { const: "visuals" } } }, then: { required: ["atIndex"] }, else: { required: ["start"] } }],
    },
  ],
};

export const WEB_MCP_EDIT_CAPABILITIES = Object.freeze(WEB_MCP_OPERATION_SCHEMA.oneOf.map((entry) => entry.properties.type.const));
