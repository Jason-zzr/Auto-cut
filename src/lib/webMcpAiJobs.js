import { MAX_TIMELINE_DURATION_SECONDS, RATIO_OPTIONS, VOICES } from "../config/editor.js";
import { canRemovePauses, findPauseCandidates } from "./silenceRemoval.js";
import { SILERO_MODEL_SHA256, SILERO_HF_REVISION, SILERO_MS_REVISION, SILERO_SPEECH_SEGMENTATION } from "../config/sileroVad.js";
import { AUTOMATIC_CAPTION_MODEL_ID, VOCAL_SEPARATION_MODEL_REVISION, REMASTER_DRUNET_MODEL, YOLOS_TINY_MODEL_ID, YOLOS_TINY_MODEL_REVISION } from "../config/models.js";
import { REMASTER_MODE_STRENGTH } from "./remasterEnhancement.js";
import { VOICE_MODEL_HUGGING_FACE_REVISION, VOICE_MODEL_MODELSCOPE_REVISION } from "../config/voiceModels.js";
import { DEFAULT_GENERATED_VOICE_GAP } from "./generatedVoicePlacement.js";
import { prepareTextForVoice, splitTextAtSentenceEnd } from "./ttsText.js";
import { AI_MUSIC_PRESETS, AI_MUSIC_MODEL_REVISION } from "./aiMusicPrompt.js";
import { getVisualSegmentTimeline } from "./timeline.js";
import { normalizeVisualPlaybackRate } from "./visualEffects.js";
import { normalizeVisualSpeedCurve } from "./visualSpeedCurve.js";
import { OPENVOICE_EMBEDDING_VERSION } from "./openVoiceRuntime.js";
import { MIGAN_REGIONS_SCHEMA, validateMiganRegions } from "./miganRepairRegions.js";
import { DEPTH_MODEL_REPOSITORY, DEPTH_MODEL_PATH, DEPTH_MODEL_HUGGING_FACE_REVISION, DEPTH_MODEL_MODELSCOPE_REVISION, getDepthAnalysisSignature } from "./depthOfField.js";
import { RIFE_MODEL_SHA256 } from "./rifeModelSources.js";
import { JOYVASA_WEB_MODEL, JOYVASA_PROJECT_MODEL_BASE_URL } from "../config/joyVasa.js";
import { LIVE_PORTRAIT_WEB_MODEL } from "../config/livePortrait.js";

const LANGUAGES = ["zh", "en", "ja", "ko", "es", "fr", "de", "pt", "th", "vi", "ru", "it", "id"];
const VOICE_LANGUAGES = { 中文: "zh", English: "en", 日本語: "ja", 한국어: "ko", Español: "es", Français: "fr", Deutsch: "de", Português: "pt", ไทย: "th", "Tiếng Việt": "vi", Русский: "ru", Italiano: "it", "Bahasa Indonesia": "id" };
const MAX_TEXT = 2000;
const MAX_SEGMENTS = 80;
const MAX_TRANSCRIPTION_SECONDS = 120;
const MIN_CAPTION_SECONDS = 0.2;
const MAX_JOBS = 32;
const MAX_REQUESTS = 1024;
const NO_MODEL_JOB_KINDS = new Set(["audio_reverse", "source_audio_extract"]);
const terminal = (status) => ["succeeded", "failed", "cancelled"].includes(status);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("INVALID_ARGUMENT");
};
const string = (value, maximum = 256) => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail("INVALID_ARGUMENT");
  return value;
};
const number = (value, minimum, maximum) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail("INVALID_ARGUMENT");
  return value;
};
const aborted = (signal) => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };
const schema = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
const time = { type: "number", minimum: 0, maximum: MAX_TIMELINE_DURATION_SECONDS };
const id = { type: "string", minLength: 1, maxLength: 256 };

export const WEB_MCP_AI_REQUEST_SCHEMA = {
  oneOf: [
    schema({ kind: { type: "string", const: "pause_detect" }, assetId: id, clipId: id,
      minimum: { type: "number", minimum: 0.5, maximum: 5 }, keep: { type: "number", minimum: 0.3, maximum: 1 } }, ["kind", "assetId", "clipId"]),
    schema({ kind: { type: "string", const: "audio_reverse" }, clipId: id, reversed: { type: "boolean" } }, ["kind", "clipId", "reversed"]),
    schema({ kind: { type: "string", const: "source_audio_extract" }, assetId: id, clipId: id }, ["kind", "assetId", "clipId"]),
    schema({ kind: { type: "string", const: "smart_frame" }, assetId: id, clipId: id,
      targetRatio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5"] },
      motion: { type: "string", enum: ["locked", "smooth", "responsive"] },
      padding: { type: "number", minimum: 0.04, maximum: 0.4 },
      maxZoom: { type: "number", minimum: 1, maximum: 2 } }, ["kind", "assetId", "clipId", "targetRatio"]),
    schema({ kind: { type: "string", const: "caption_avoidance" }, assetId: id, clipId: id }, ["kind", "assetId", "clipId"]),
    schema({ kind: { type: "string", const: "avatar" }, assetId: id, referenceAssetId: id,
      quality: { type: "string", enum: ["preview", "quality"] }, duration: { type: "number", minimum: 0.25, maximum: 4 },
      renderFps: { type: "number", minimum: 1, maximum: 30 }, neuralFps: { type: "number", minimum: 1, maximum: 30 } }, ["kind", "assetId", "referenceAssetId"]),
    { ...schema({ kind: { type: "string", const: "auto_caption" }, scope: { type: "string", enum: ["clip", "project"] },
      assetId: id, clipId: id, language: { type: "string", enum: LANGUAGES } }, ["kind"]),
      oneOf: [
        { properties: { scope: { const: "clip" } }, required: ["assetId", "clipId"] },
        { properties: { scope: { const: "project" } }, required: ["scope"] },
      ] },
    schema({ kind: { type: "string", const: "depth_map" }, assetId: id, clipId: id,
      output: { type: "string", enum: ["video", "analysis"], description: "analysis requires clipId; returns native depth samples for reviewed attachment, without video encoding or automatic effect application." },
      quality: { type: "string", enum: ["fast", "balanced", "quality"] }, inverted: { type: "boolean" } }, ["kind", "assetId"]),
    schema({ kind: { type: "string", const: "nanovsr" }, assetId: id, clipId: id,
      frameRate: { type: "integer", minimum: 1, maximum: 15 } }, ["kind", "assetId", "clipId"]),
    schema({ kind: { type: "string", const: "visual_repair" }, assetId: id, clipId: id, sourceStart: time, duration: time,
      playbackRate: { type: "number", minimum: 0.25, maximum: 4 },
      regions: MIGAN_REGIONS_SCHEMA }, ["kind", "assetId", "regions"]),
    { ...schema({ kind: { type: "string", const: "visual_cutout" }, detectionJobId: id, assetId: id, clipId: id,
      output: { type: "string", enum: ["image", "video"] },
      sourceStart: { ...time, description: "Video target box belongs to this source time; detection candidates must use their detection time." },
      duration: { ...time, exclusiveMinimum: 0, description: "Source seconds to track forward; defaults to the remaining video." },
      flowFps: { type: "number", minimum: 1, maximum: 30 }, anchorFps: { type: "number", minimum: 0.1, maximum: 30 },
      maxSamples: { type: "integer", minimum: 2, maximum: 3600 }, maxDimension: { type: "integer", minimum: 64, maximum: 1024 },
      target: schema({ label: id, score: { type: "number", minimum: 0, maximum: 1 },
        box: schema(Object.fromEntries(["xmin", "ymin", "xmax", "ymax"].map(key => [key, { type: "number", minimum: 0, maximum: 1 }])), ["xmin", "ymin", "xmax", "ymax"]) }, ["label", "score", "box"]),
      candidateIndex: { type: "integer", minimum: 0, maximum: 23 } }, ["kind"]),
      oneOf: [{ required: ["detectionJobId", "candidateIndex"] }, { required: ["assetId", "target"] }] },
    schema({ kind: { type: "string", const: "visual_detect" }, assetId: id, sourceTime: time,
      scoreThreshold: { type: "number", minimum: 0.01, maximum: 0.99 } }, ["kind", "assetId"]),
    { ...schema({ kind: { type: "string", const: "voice_convert" }, assetId: id, cloneVoiceProfileId: id, clipId: id, track: { type: "string", enum: ["audio", "source"] },
      referenceAssetId: id, referenceRecordingId: id, voiceSourceAuthorized: { type: "boolean", const: true } }, ["kind", "assetId"]),
      oneOf: [{ required: ["cloneVoiceProfileId"] }, { required: ["referenceAssetId"] }, { required: ["referenceRecordingId"] }],
      dependencies: { referenceAssetId: ["voiceSourceAuthorized"], referenceRecordingId: ["voiceSourceAuthorized"] } },
    { ...schema({ kind: { type: "string", const: "voice_clone_preview" }, assetId: id, recordingId: id, voiceId: id,
      voiceSourceAuthorized: { type: "boolean", const: true } }, ["kind", "voiceId", "voiceSourceAuthorized"]),
      oneOf: [{ required: ["assetId"] }, { required: ["recordingId"] }] },
    schema({ kind: { type: "string", const: "denoise" }, assetId: id, clipId: id,
      preset: { type: "string", enum: ["auto", ...Object.keys(REMASTER_MODE_STRENGTH)] } }, ["kind", "assetId", "clipId", "preset"]),
    { ...schema({ kind: { type: "string", const: "separation" }, track: { type: "string", enum: ["asset", "source"] }, assetId: id, clipId: id, sourceStart: time,
      duration: { ...time, exclusiveMinimum: 0 }, timelineOffset: time }, ["kind"]),
      oneOf: [
        { properties: { track: { const: "source" } }, required: ["track"], not: { anyOf: [{ required: ["assetId"] }, { required: ["clipId"] }, { required: ["sourceStart"] }, { required: ["duration"] }, { required: ["timelineOffset"] }] } },
        { properties: { track: { enum: ["asset"] } }, required: ["assetId"] },
      ] },
    schema({
      kind: { type: "string", const: "music" }, description: { type: "string", maxLength: 2000 },
      ...Object.fromEntries(Object.entries(AI_MUSIC_PRESETS).map(([key, presets]) => [key, { type: "string", enum: presets.map(([id]) => id) }])),
      seconds: { type: "number", enum: [30, 60, 90, 120] }, bpm: { type: "number", minimum: 60, maximum: 180 }, timelineOffset: time,
    }, ["kind", "description", "style", "mood", "instrument", "seconds", "bpm"]),
    schema({
      kind: { type: "string", const: "voiceover" }, voiceId: id, cloneVoiceProfileId: id,
      text: { type: "string", minLength: 1, maxLength: MAX_TEXT },
      speed: { type: "number", minimum: 0.7, maximum: 1.3 },
      gain: { type: "number", minimum: 0, maximum: 4 }, timelineOffset: time,
    }, ["kind", "voiceId", "text"]),
    schema({
      kind: { type: "string", const: "transcription" }, assetId: id,
      language: { type: "string", enum: LANGUAGES }, sourceStart: time,
      duration: { type: "number", minimum: MIN_CAPTION_SECONDS, maximum: MAX_TRANSCRIPTION_SECONDS }, timelineOffset: time,
    }, ["kind", "assetId"]),
  ],
};

// Keep the narrator stable across independently synthesized breath groups. Long
// phrases use word boundaries (or characters for CJK), never a giant Hojo request.
function breathGroups(text) {
  const groups = [];
  for (const sentence of splitTextAtSentenceEnd(text)) {
    // Protect numeric commas and avoid colon splitting inside URLs/names.
    const phrases = sentence.split(/(?<=[，；;])\s*|(?<=(?<!\d),)\s*|(?<=\d,)(?!\d)\s*/u).filter(Boolean);
    for (let phraseIndex = 0; phraseIndex < phrases.length; phraseIndex += 1) {
      let phrase = phrases[phraseIndex];
      const fragmentThreshold = /\p{Script=Han}/u.test(phrase) ? 4 : 10;
      if (phrase.trim().length < fragmentThreshold && phraseIndex + 1 < phrases.length) phrase += phrases[++phraseIndex];
      const maximum = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(phrase) ? 56 : 180;
      let rest = phrase.trim();
      while (rest.length > maximum) {
        const space = rest.lastIndexOf(" ", maximum);
        const end = space > maximum / 2 ? space : maximum;
        groups.push(rest.slice(0, end).trim());
        rest = rest.slice(end).trim();
      }
      if (rest) groups.push(rest);
    }
  }
  if (!groups.length || groups.length > MAX_SEGMENTS) fail("INVALID_ARGUMENT");
  return groups;
}

function browserSupport(voice) {
  const audio = Boolean(globalThis.AudioContext || globalThis.webkitAudioContext);
  const wasm = typeof WebAssembly !== "undefined";
  return audio && wasm && (voice?.engine !== "hojo" || Boolean(globalThis.navigator?.gpu && globalThis.Worker));
}

/** Page-scoped jobs reuse the production synthesis/ASR services and their caches.
 * The host owns preview/fingerprint validation and the atomic My assets commit.
 * No timeline mutation, model-cache probing, or download occurs during prepare.
 */
export function createWebMcpAiJobs(getEditor, { makeId = () => crypto.randomUUID(), onUpdate = () => {}, acquireProcessing } = {}) {
  const jobs = new Map();
  const requests = new Map();
  let active = null;
  let closed = false;
  const guard = () => { if (closed) fail("SESSION_CLOSED"); };
  const describe = (job) => clone({
    jobId: job.jobId, requestId: job.requestId, stateToken: job.stateToken, kind: job.plan.request.kind,
    status: job.status, progress: job.progress, progressKind: "reported-stage-progress",
    phaseKey: job.phaseKey, cancelRequested: job.cancelRequested,
    ...(job.waitReason ? { waitReason: job.waitReason } : {}),
    cancellation: job.plan.cancellation,
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    ...(job.segment ? { segment: job.segment } : {}),
    ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}),
  });
  const publish = (job) => { try { onUpdate(describe(job)); } catch { /* Observers cannot interrupt inference/commits. */ } };
  const update = (job, phaseKey, progress, segment) => {
    if (terminal(job.status)) return;
    if (job.phaseKey !== phaseKey || (segment && segment.current !== job.segment?.current)) job.progress = null;
    job.phaseKey = phaseKey;
    if (Number.isFinite(progress)) job.progress = Math.max(0, Math.min(99, Math.round(progress)));
    if (segment) job.segment = segment;
    publish(job);
  };
  const mediaSource = item => item?.blob instanceof Blob && item.blob.size > 0 ? item.blob
    : typeof item?.src === "string" && item.src ? item.src
    : typeof item?.url === "string" && item.url ? item.url : null;
  const findAsset = (assetId, type = "audio", { allowUrl = false } = {}) => {
    const asset = (getEditor().assets || []).find((item) => (item.assetId || item.id) === assetId);
    if (!asset) fail("ASSET_NOT_FOUND");
    if (asset.preparing) fail("ASSET_NOT_READY");
    const hasMedia = asset.blob instanceof Blob && asset.blob.size > 0 || allowUrl && Boolean(mediaSource(asset));
    if (!(Array.isArray(type) ? type.includes(asset.type) : asset.type === type) || !hasMedia || asset.type !== "image" && !(asset.duration > 0)) fail("AI_INVALID_SOURCE");
    return asset;
  };
  const captureAutoCaptionBindings = plan => (plan.source.segments || [plan.source]).map(source => {
    const editor = getEditor();
    const asset = findAsset(source.assetId, ["image", "video"], { allowUrl: true });
    const clips = source.track === "overlays" ? editor.visualOverlaySegments || [] : editor.visualSegments || [];
    const clip = clips.find(item => item.id === source.clipId);
    const media = mediaSource(asset);
    if (!clip || clip.type !== source.type || mediaSource(clip) !== media) fail("STALE_STATE");
    return { source, clip, media };
  });
  const assertAutoCaptionBindings = bindings => {
    const editor = getEditor();
    for (const binding of bindings) {
      const clips = binding.source.track === "overlays" ? editor.visualOverlaySegments || [] : editor.visualSegments || [];
      const asset = (editor.assets || []).find(item => (item.assetId || item.id) === binding.source.assetId);
      if (!asset || asset.preparing || asset.type !== binding.source.type || mediaSource(asset) !== binding.media ||
          clips.find(item => item.id === binding.source.clipId) !== binding.clip || mediaSource(binding.clip) !== binding.media) fail("STALE_STATE");
    }
  };
  const findVoiceReference = request => {
    if ((request.assetId !== undefined) === (request.recordingId !== undefined)) fail("INVALID_ARGUMENT");
    if (request.assetId !== undefined) return findAsset(string(request.assetId));
    const recordingId = string(request.recordingId);
    const recording = getEditor().recordedVoices?.find(item => item.id === recordingId);
    if (!recording) fail("ASSET_NOT_FOUND");
    if (!(recording.blob instanceof Blob) || !recording.blob.size || !Number.isFinite(recording.duration) || recording.duration <= 0) fail("AI_INVALID_SOURCE");
    return recording;
  };
  const capabilities = (input = {}) => {
    guard(); object(input, ["language", "kind"]);
    if (input.language !== undefined && !LANGUAGES.includes(input.language)) fail("INVALID_ARGUMENT");
    if (input.kind !== undefined) {
      const requestSchema = WEB_MCP_AI_REQUEST_SCHEMA.oneOf.find(entry => entry.properties.kind.const === input.kind);
      if (!requestSchema) fail("INVALID_ARGUMENT");
      return { kind: input.kind, requestSchema: structuredClone(requestSchema) };
    }
    return {
      requestKinds: WEB_MCP_AI_REQUEST_SCHEMA.oneOf.map(entry => entry.properties.kind.const),
      execution: "browser-local", modelReadiness: "not-probed", modelDownload: "on-demand-at-start",
      requiresPrepare: true, requiresAllowModelDownload: true, maxConcurrentJobs: 1,
      audioReverse: { available: browserSupport() && typeof getEditor().commitAiVoiceAssets === "function",
        requestKind: "audio_reverse", source: "audio-clip-retained-original", requiresAllowModelDownload: false,
        modelDownload: "none", delivery: "my-assets-and-reviewed-replacement", timelineInsertion: false },
      sourceAudioExtraction: { available: typeof getEditor().commitAiVoiceAssets === "function",
        requestKind: "source_audio_extract", source: "exact-main-or-overlay-video-clip", requiresAllowModelDownload: false,
        modelDownload: "none", timeMapping: "pitch-preserved-clip-timing", speedCurveMapping: true,
        delivery: "my-assets-and-reviewed-audio-placement", originalClipMutedThroughReview: true, timelineInsertion: false },
      smartFrame: { available: typeof globalThis.Worker === "function", requestKind: "smart_frame",
        source: "exact-main-or-overlay-image-or-video-clip", targetRatios: RATIO_OPTIONS.map(option => option.id),
        motion: ["locked", "smooth", "responsive"], padding: { minimum: 0.04, maximum: 0.4, default: 0.16 },
        maxZoom: { minimum: 1, maximum: 2, default: 1.45 }, modelId: YOLOS_TINY_MODEL_ID,
        modelRevision: YOLOS_TINY_MODEL_REVISION, pipeline: "original-YOLOS-subject-detection-and-Farneback-flow",
        delivery: "reviewed-project-ratio-and-clip-smart-frame", timelineInsertion: false },
      captionAvoidance: { available: typeof globalThis.Worker === "function", requestKind: "caption_avoidance",
        source: "exact-main-or-overlay-image-or-video-clip", modelId: YOLOS_TINY_MODEL_ID,
        modelRevision: YOLOS_TINY_MODEL_REVISION, pipeline: "original-YOLOS-subject-detection-and-Farneback-flow",
        delivery: "reviewed-clip-caption-avoidance-analysis", timelineInsertion: false },
      nanoVsr: { available: typeof globalThis.Worker === "function" && typeof getEditor().commitAiVisualAsset === "function",
        requestKind: "nanovsr", source: ["image", "video"], defaultFrameRate: 12, frameRateRange: [1, 15],
        modelPaths: ["haixin/timeline-studio-onnx-models@d551be137b16ecdf12637387f2fb4776565e763f/nanovsr-644k/nanovsr-644k-t1-fp16.onnx",
          "haixin/timeline-studio-onnx-models@d551be137b16ecdf12637387f2fb4776565e763f/nanovsr-644k/nanovsr-644k-t5-fp16.onnx"],
        delivery: "my-assets-and-reviewed-replacement", timelineInsertion: false, requiresWebGPU: true },
      visualRepair: { available: typeof globalThis.Worker === "function" && typeof getEditor().commitAiVisualAsset === "function",
        requestKind: "visual_repair", modelPath: "haixin/timeline-studio-onnx-models@d551be137b16ecdf12637387f2fb4776565e763f/migan-webgpu/migan-generator-256.onnx",
        source: ["image", "video"], coordinates: "normalized-source-frame", regionTime: "trimmed-clip-local-seconds-at-playbackRate",
        pipeline: "original-MI-GAN-temporal-repair", delivery: "my-assets", timelineInsertion: false },
      avatar: { available: browserSupport() && typeof globalThis.Worker === "function" && typeof globalThis.VideoEncoder === "function" && typeof getEditor().commitAiVisualAsset === "function",
        requestKind: "avatar", source: "local-portrait-image-and-driving-audio", quality: ["preview", "quality"], maxDuration: 4,
        modelBasis: { joyVasa: { id: JOYVASA_WEB_MODEL.id, revision: JOYVASA_WEB_MODEL.revision },
          livePortrait: { id: LIVE_PORTRAIT_WEB_MODEL.id, revision: LIVE_PORTRAIT_WEB_MODEL.revision }, projectModelBase: JOYVASA_PROJECT_MODEL_BASE_URL },
        delivery: "my-assets-avatar-video", audioIncluded: false, timelineInsertion: false },
      pauseDetection: { available: typeof globalThis.Worker === "function", requestKind: "pause_detect",
        modelBasis: { modelSha256: SILERO_MODEL_SHA256, huggingFaceRevision: SILERO_HF_REVISION,
          modelScopeRevision: SILERO_MS_REVISION, segmentation: SILERO_SPEECH_SEGMENTATION },
        source: "exact-main-video-clip", pipeline: "original-Silero-VAD", minimum: { min: 0.5, max: 5, default: 0.8 },
        keep: { min: 0.3, max: 1, default: 0.5 }, delivery: "pause-candidates", timelineInsertion: false },
      autoCaption: { available: typeof globalThis.Worker === "function" && Boolean(globalThis.window?.LanguageModel),
        requestKind: "auto_caption", languages: LANGUAGES, model: "original-browser-built-in-LanguageModel-and-Translator",
        source: "exact-main-or-overlay-clip-or-all-main-visual-clips",
        readiness: "already-available-models-only; prepare-missing-models-in-original-UI", pipeline: "original-scene-motion-keyframes-and-frame-captions",
        delivery: "caption.add-operations-for-edit-preview", timelineInsertion: false },
      depthMap: { available: typeof globalThis.Worker === "function" && typeof getEditor().commitAiVisualAsset === "function",
        requestKind: "depth_map", source: ["image", "video"], quality: ["fast", "balanced", "quality"], defaultQuality: "balanced",
        outputs: ["video", "analysis"], analysisRequiresClipId: true, analysisDelivery: "clip.apply_depth_analysis-operation-for-review",
        modelRepository: DEPTH_MODEL_REPOSITORY, modelPath: DEPTH_MODEL_PATH,
        modelRevisions: { huggingface: DEPTH_MODEL_HUGGING_FACE_REVISION, modelscope: DEPTH_MODEL_MODELSCOPE_REVISION },
        interpolation: { pipeline: "original-RIFE-for-fast-and-balanced-video", modelSha256: RIFE_MODEL_SHA256 }, executionProvider: "webgpu", delivery: "my-assets-depth-video", timelineInsertion: false },
      visualDetection: { available: typeof globalThis.Worker === "function", requestKind: "visual_detect",
        modelId: "NanoDet-Plus-m-320", source: "local-image-or-exact-video-source-time", delivery: "candidate-boxes",
        modelPath: "timeline-studio-onnx-models@f1005093a90dec7a23746518f9623ee6aaba9cdc/object-outline/nanodet-plus-m_320.onnx",
        coordinates: "normalized-source-frame", automaticTargetSelection: false, timelineInsertion: false },
      visualCutout: { available: typeof globalThis.Worker === "function" && typeof getEditor().commitAiVisualAsset === "function",
        requestKind: "visual_cutout", source: ["exact-frame-and-candidate-of-successful-current-page-detection-job", "saved-image-asset-with-explicit-target-box", "video-asset-with-explicit-first-frame-target-box"],
        modelPaths: ["timeline-studio-onnx-models@f1005093a90dec7a23746518f9623ee6aaba9cdc/object-outline/magic_touch_512.tflite", "Xenova/slimsam-77-uniform@5850ab45f587c112167512ffef949107115e26a0"],
        delivery: "my-assets-transparent-image", pipeline: "original-MagicTouch-SlimSAM", automaticTargetSelection: false,
        timelineInsertion: false, optionalImageClipBinding: "clipId requires the exact source image and returns clip.apply_vision_cutout for review",
        detectionLifetime: "current-page-job", videoOutput: "output=video: full-source-transparent-WebM; otherwise single-detected-frame",
        videoPipeline: "original-MagicTouch-SlimSAM-Farneback-and-PNG-sequence-encoder", targetLost: "fail-without-reselecting", videoTargetSourceTime: 0 },
      denoise: { available: typeof globalThis.Worker === "function" && typeof getEditor().commitAiVisualAsset === "function",
        modelId: REMASTER_DRUNET_MODEL.id, modelRevision: REMASTER_DRUNET_MODEL.revision,
        presets: ["auto", ...Object.keys(REMASTER_MODE_STRENGTH)], maxLongEdge: 960, frameRate: "source-with-original-fallback",
        automaticStrengthFrame: "first-frame-of-retained-source-range", delivery: "my-assets-and-reviewed-replacement", timelineInsertion: false,
        cancellation: "original-renderer-abort" },
      separation: {
        available: browserSupport() && typeof globalThis.Worker === "function" && typeof getEditor().commitAiVoiceAssets === "function",
        modelId: "haixin/timeline-studio-vocal-remover", modelRevision: VOCAL_SEPARATION_MODEL_REVISION,
        source: "ready-local-audio-video-asset-range-or-timeline-clip-or-current-shared-source-track", delivery: "my-assets-with-reviewed-routing", outputs: ["vocals", "accompaniment"],
        sourceTrackRouting: "track=source replaces the shared source-audio and music tracks only after review",
        timeMapping: "pitch-preserved-clip-timing", speedCurveMapping: true,
        timelineInsertion: false, cancellation: "discard-after-current-inference",
      },
      music: {
        available: typeof getEditor().generateAiMusic === "function" && Boolean(globalThis.navigator?.gpu && globalThis.Worker),
        model: "Stable Audio 3 Small · ONNX", modelRevision: AI_MUSIC_MODEL_REVISION, delivery: "my-assets", timelineInsertion: false,
        presets: AI_MUSIC_PRESETS, seconds: [30, 60, 90, 120], bpm: { minimum: 60, maximum: 180 },
        steps: 8, seed: "random", extendedDuration: "repeat-at-best-boundary", translation: "browser-local-if-needed",
        cancellation: "terminate-worker-and-discard-before-asset-registration",
      },
      voiceConversion: {
        available: browserSupport() && typeof globalThis.Worker === "function" && typeof getEditor().registerVoiceColorAsset === "function",
        requestKind: "voice_convert", source: "ready-local-audio-asset", optionalClipBinding: "audio-track-clip-or-unlinked-source-audio-with-same-blob",
        target: ["saved-voice-profile", "reference-audio-asset", "current-session-reference-recording"], temporaryReferenceRequiresVoiceAuthorization: true,
        converter: "OpenVoice V2", embeddingVersion: OPENVOICE_EMBEDDING_VERSION,
        inputRange: "entire-source-blob-as-in-original-voice-color-tool", delivery: "my-assets", timelineInsertion: false,
        cancellation: "discard-after-current-inference",
      },
      voiceover: {
        available: browserSupport() && typeof getEditor().commitAiVoiceAssets === "function",
        maxTextCharacters: MAX_TEXT, maxSegments: MAX_SEGMENTS, delivery: "my-assets", timelineInsertion: false,
        segmentation: "breath-groups", suggestedGap: DEFAULT_GENERATED_VOICE_GAP,
        cancellation: "cooperative-discard-current-segment", cloneEnrollment: {
          available: browserSupport() && typeof globalThis.Worker === "function" && Boolean(getEditor().voiceLibraryReady)
            && typeof getEditor().addVoiceProfile === "function" && typeof getEditor().commitAiVoiceAssets === "function",
          requestKind: "voice_clone_preview", source: ["ready-local-audio-asset", "current-session-recording"], voiceSourceAuthorizationRequired: true,
          saveTool: "timeline_voice_profile_save", saveAfterAudition: true, draftLifetime: "current-page-job",
        },
        cloneProfiles: (getEditor().voiceProfiles || []).map(profile => ({ profileId: profile.id, name: profile.name || "",
          available: Boolean(browserSupport() && typeof globalThis.Worker === "function" && getEditor().voiceLibraryReady && profile.embedding?.length), embeddingVersion: profile.embeddingVersion ?? null })),
        cloneConverter: { name: "OpenVoice V2", embeddingVersion: OPENVOICE_EMBEDDING_VERSION },
        ownedModelRevisions: { huggingFace: VOICE_MODEL_HUGGING_FACE_REVISION, modelScope: VOICE_MODEL_MODELSCOPE_REVISION },
        voices: VOICES.filter((voice) => !input.language || VOICE_LANGUAGES[voice.language] === input.language).map((voice) => ({
          voiceId: voice.id, name: voice.name, language: VOICE_LANGUAGES[voice.language], engine: voice.engine,
          available: browserSupport(voice), cacheState: "unknown",
          adjustableSpeed: voice.engine === "kokoro" || voice.engine === "supertonic",
        })),
      },
      transcription: {
        available: browserSupport() && typeof globalThis.Worker === "function", modelId: AUTOMATIC_CAPTION_MODEL_ID,
        source: "ready-local-audio-asset", timeMapping: "source-range-seconds-plus-timeline-offset",
        maxDuration: MAX_TRANSCRIPTION_SECONDS, languages: LANGUAGES, languageSelection: "automatic-with-preferred-language",
        delivery: "caption.add-operations-for-edit-preview", timelineInsertion: false,
        cancellation: "terminate-worker-after-audio-decode", speedCurveMapping: false,
      },
    };
  };
  const prepare = (input = {}) => {
    guard(); object(input, ["request"]);
    const raw = input.request;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_ARGUMENT");
    const timelineOffset = number(raw.timelineOffset ?? 0, 0, MAX_TIMELINE_DURATION_SECONDS);
    const downloadPolicy = { allowedAtPrepare: false, cacheState: "unknown", startRequiresAllowModelDownload: true, behavior: "reuse-existing-cache-or-fetch-missing-model-artifacts" };
    if (raw.kind === "audio_reverse") {
      object(raw, ["kind", "clipId", "reversed"]);
      if (!browserSupport() || typeof getEditor().commitAiVoiceAssets !== "function") fail("AI_UNAVAILABLE");
      const clip = getEditor().audioSegments?.find(item => item.id === string(raw.clipId));
      if (!clip || clip.reversing || typeof raw.reversed !== "boolean") fail("AI_INVALID_SOURCE");
      if (!raw.reversed && !clip.originalBlob && !clip.projectMedia?.bindings?.originalBlob) fail("AI_INVALID_SOURCE");
      return { request: { ...raw }, source: { clipId: clip.id, name: String(clip.name || "Audio") },
        downloadPolicy: { allowedAtPrepare: false, startRequiresAllowModelDownload: false, behavior: "no-model-download" },
        delivery: "my-assets-and-reviewed-replacement", timelineInsertion: false, cancellation: "discard-result-after-current-decode" };
    }
    if (raw.kind === "source_audio_extract") {
      object(raw, ["kind", "assetId", "clipId"]);
      if (typeof getEditor().commitAiVoiceAssets !== "function") fail("AI_UNAVAILABLE");
      const asset = findAsset(string(raw.assetId), "video"), editor = getEditor(), clipId = string(raw.clipId);
      const mainIndex = (editor.visualSegments || []).findIndex(item => item.id === clipId);
      const main = editor.visualSegments?.[mainIndex];
      const overlay = (editor.visualOverlaySegments || []).find(item => item.id === clipId);
      const clip = main || overlay;
      if (!clip || clip.type !== "video" || clip.blob !== asset.blob || clip.reversed || clip.reverse) fail("AI_INVALID_SOURCE");
      const playbackRate = normalizeVisualPlaybackRate(clip.playbackRate);
      const sourceStart = number(clip.sourceStart ?? 0, 0, asset.duration);
      const sourceDuration = number(clip.sourceDuration ?? clip.duration * playbackRate, Number.EPSILON, MAX_TIMELINE_DURATION_SECONDS);
      if (sourceStart + sourceDuration > asset.duration + 0.001) fail("AI_INVALID_SOURCE");
      const duration = number(clip.duration, Number.EPSILON, MAX_TIMELINE_DURATION_SECONDS);
      const start = number(main ? getVisualSegmentTimeline(editor.visualSegments)[mainIndex].start : clip.start, 0, MAX_TIMELINE_DURATION_SECONDS - duration);
      return { request: { kind: raw.kind, assetId: raw.assetId, clipId }, source: { assetId: raw.assetId, clipId,
        track: main ? "visuals" : "overlays", name: String(clip.name || asset.name || "Video"), sourceStart, sourceDuration,
        timing: { duration, playbackRate, speedCurve: normalizeVisualSpeedCurve(clip.speedCurve) }, start },
        downloadPolicy: { allowedAtPrepare: false, startRequiresAllowModelDownload: false, behavior: "no-model-download" },
        delivery: "my-assets-and-reviewed-audio-placement", timelineInsertion: false, cancellation: "discard-result-after-current-decode" };
    }
    if (raw.kind === "smart_frame") {
      object(raw, ["kind", "assetId", "clipId", "targetRatio", "motion", "padding", "maxZoom"]);
      if (typeof globalThis.Worker !== "function") fail("AI_UNAVAILABLE");
      const asset = findAsset(string(raw.assetId), ["image", "video"]), editor = getEditor(), clipId = string(raw.clipId);
      const main = (editor.visualSegments || []).find(item => item.id === clipId);
      const overlay = (editor.visualOverlaySegments || []).find(item => item.id === clipId);
      const clip = main || overlay;
      if (!clip || clip.type !== asset.type || clip.blob !== asset.blob) fail("AI_INVALID_SOURCE");
      const ratio = RATIO_OPTIONS.find(option => option.id === raw.targetRatio);
      if (!ratio) fail("INVALID_ARGUMENT");
      const motion = raw.motion ?? "smooth";
      if (!["locked", "smooth", "responsive"].includes(motion)) fail("INVALID_ARGUMENT");
      const settings = { motion, padding: number(raw.padding ?? 0.16, 0.04, 0.4), maxZoom: number(raw.maxZoom ?? 1.45, 1, 2) };
      return { request: { kind: raw.kind, assetId: raw.assetId, clipId, targetRatio: ratio.id, ...settings },
        source: { assetId: raw.assetId, clipId, track: main ? "visuals" : "overlays", name: String(clip.name || asset.name || asset.type),
          type: asset.type, sourceStart: Math.max(0, Number(clip.sourceStart) || 0),
          sourceDuration: Math.max(0, Number(clip.sourceDuration) || Number(clip.duration) || 0),
          playbackRate: normalizeVisualPlaybackRate(clip.playbackRate) },
        target: { ratio: ratio.id, width: ratio.width, height: ratio.height }, settings, downloadPolicy,
        delivery: "reviewed-project-ratio-and-clip-smart-frame", timelineInsertion: false,
        cancellation: "original-subject-detector-and-flow-worker-abort" };
    }
    if (raw.kind === "caption_avoidance") {
      object(raw, ["kind", "assetId", "clipId"]);
      if (typeof globalThis.Worker !== "function") fail("AI_UNAVAILABLE");
      const asset = findAsset(string(raw.assetId), ["image", "video"]), editor = getEditor(), clipId = string(raw.clipId);
      const main = (editor.visualSegments || []).find(item => item.id === clipId);
      const overlay = (editor.visualOverlaySegments || []).find(item => item.id === clipId);
      const clip = main || overlay;
      if (!clip || clip.type !== asset.type || clip.blob !== asset.blob) fail("AI_INVALID_SOURCE");
      const sourceStart = number(clip.sourceStart ?? 0, 0, MAX_TIMELINE_DURATION_SECONDS);
      const sourceDuration = number(clip.sourceDuration ?? clip.duration, Number.EPSILON, MAX_TIMELINE_DURATION_SECONDS);
      if (asset.type === "video" && sourceStart + sourceDuration > Number(asset.duration) + 0.001) fail("AI_INVALID_SOURCE");
      return { request: { kind: raw.kind, assetId: raw.assetId, clipId },
        source: { assetId: raw.assetId, clipId, track: main ? "visuals" : "overlays", name: String(clip.name || asset.name || asset.type),
          type: asset.type, sourceStart, sourceDuration,
          playbackRate: normalizeVisualPlaybackRate(clip.playbackRate) },
        downloadPolicy, delivery: "reviewed-clip-caption-avoidance-analysis", timelineInsertion: false,
        cancellation: "original-subject-detector-and-flow-worker-abort" };
    }
    if (raw.kind === "avatar") {
      object(raw, ["kind", "assetId", "referenceAssetId", "quality", "duration", "renderFps", "neuralFps"]);
      if (!browserSupport() || typeof globalThis.Worker !== "function" || typeof globalThis.VideoEncoder !== "function" || typeof getEditor().commitAiVisualAsset !== "function") fail("AI_UNAVAILABLE");
      const portrait = findAsset(string(raw.assetId), "image"), audio = findAsset(string(raw.referenceAssetId));
      const quality = raw.quality ?? "preview";
      if (!["preview", "quality"].includes(quality)) fail("INVALID_ARGUMENT");
      const duration = number(raw.duration ?? Math.min(4, audio.duration), 0.25, Math.min(4, audio.duration));
      const renderFps = number(raw.renderFps ?? 8, 1, 30), neuralFps = number(raw.neuralFps ?? Math.min(2, renderFps), 1, renderFps);
      return { request: { ...raw, quality, duration, renderFps, neuralFps }, source: { assetId: raw.assetId, name: String(portrait.name || "Portrait"),
        referenceAssetId: raw.referenceAssetId, audioName: String(audio.name || "Audio"), duration, language: getEditor().language || "en" },
        downloadPolicy, delivery: "my-assets-avatar-video", audioIncluded: false, timelineInsertion: false, cancellation: "original-avatar-workers-and-encoder-abort" };
    }
    if (raw.kind === "pause_detect") {
      object(raw, ["kind", "assetId", "clipId", "minimum", "keep"]);
      if (typeof globalThis.Worker !== "function") fail("AI_UNAVAILABLE");
      const asset = findAsset(string(raw.assetId), "video", { allowUrl: true }), editor = getEditor();
      const clipId = string(raw.clipId), index = (editor.visualSegments || []).findIndex(item => item.id === clipId);
      const clip = editor.visualSegments?.[index];
      if (!clip || mediaSource(clip) !== mediaSource(asset) || clip.type !== "video") fail("AI_INVALID_SOURCE");
      if (!canRemovePauses(clip, editor.visualSegments[index - 1])) fail("AI_INVALID_SOURCE");
      const minimum = number(raw.minimum ?? 0.8, 0.5, 5), keep = number(raw.keep ?? 0.5, 0.3, 1);
      return { request: { ...raw, minimum, keep }, source: { assetId: raw.assetId, clipId, name: String(asset.name || "Video") },
        downloadPolicy, delivery: "pause-candidates", timelineInsertion: false, cancellation: "original-VAD-worker-abort" };
    }
    if (raw.kind === "auto_caption") {
      object(raw, ["kind", "scope", "assetId", "clipId", "language"]);
      if (typeof globalThis.Worker !== "function" || !globalThis.window?.LanguageModel) fail("AI_UNAVAILABLE");
      const editor = getEditor(), scope = raw.scope ?? "clip";
      if (!["clip", "project"].includes(scope)) fail("INVALID_ARGUMENT");
      const language = raw.language ?? editor.language?.split("-")[0] ?? "en";
      if (!LANGUAGES.includes(language)) fail("INVALID_ARGUMENT");
      const download = { ...downloadPolicy, behavior: "require-already-available-browser-models", readiness: "already-available-models-only" };
      if (scope === "project") {
        if (raw.assetId !== undefined || raw.clipId !== undefined) fail("INVALID_ARGUMENT");
        const clips = editor.visualSegments || [];
        if (!clips.length || clips.length > MAX_SEGMENTS) fail("AI_INVALID_SOURCE");
        const timeline = getVisualSegmentTimeline(clips);
        const segments = clips.map((clip, index) => {
          const asset = (editor.assets || []).find(item => clip.assetId && (item.assetId || item.id) === clip.assetId)
            || (editor.assets || []).find(item => item.type === clip.type && mediaSource(item) === mediaSource(clip));
          if (!asset) fail("ASSET_NOT_FOUND");
          const assetId = asset.assetId || asset.id;
          findAsset(assetId, ["image", "video"], { allowUrl: true });
          if (!mediaSource(clip) || mediaSource(clip) !== mediaSource(asset)) fail("AI_INVALID_SOURCE");
          return { assetId, clipId: string(clip.id), track: "visuals", type: asset.type,
            name: String(clip.name || asset.name || asset.type),
            duration: number(clip.duration, MIN_CAPTION_SECONDS, MAX_TIMELINE_DURATION_SECONDS), timelineOffset: timeline[index].start };
        });
        const duration = number(timeline.at(-1)?.end, MIN_CAPTION_SECONDS, MAX_TIMELINE_DURATION_SECONDS);
        return { request: { ...raw, scope, language }, source: { scope, duration, segments }, downloadPolicy: download,
          delivery: "caption.add-operations-for-edit-preview", timelineInsertion: false, cancellation: "original-frame-analysis-and-caption-signal" };
      }
      const asset = findAsset(string(raw.assetId), ["image", "video"], { allowUrl: true });
      const clipId = string(raw.clipId);
      const main = (editor.visualSegments || []).find(item => item.id === clipId);
      const clip = main || (editor.visualOverlaySegments || []).find(item => item.id === clipId);
      if (!clip || mediaSource(clip) !== mediaSource(asset) || clip.type !== asset.type) fail("AI_INVALID_SOURCE");
      const duration = number(clip.duration, MIN_CAPTION_SECONDS, MAX_TIMELINE_DURATION_SECONDS);
      const timelineOffset = number(main ? getVisualSegmentTimeline(editor.visualSegments).find(item => item.id === clipId).start : clip.start, 0, MAX_TIMELINE_DURATION_SECONDS - duration);
      return { request: { ...raw, scope, language }, source: { scope, assetId: raw.assetId, clipId, track: main ? "visuals" : "overlays",
        type: asset.type, name: String(asset.name || asset.type), duration, timelineOffset },
        downloadPolicy: download, delivery: "caption.add-operations-for-edit-preview", timelineInsertion: false,
        cancellation: "original-frame-analysis-and-caption-signal" };
    }
    if (raw.kind === "depth_map") {
      object(raw, ["kind", "assetId", "clipId", "quality", "inverted", "output"]);
      const output = raw.output ?? "video";
      if (!["video", "analysis"].includes(output) || output === "analysis" && (raw.clipId === undefined || raw.inverted !== undefined)) fail("INVALID_ARGUMENT");
      if (typeof globalThis.Worker !== "function" || typeof getEditor()[output === "analysis" ? "retainDepthAnalysis" : "commitAiVisualAsset"] !== "function") fail("AI_UNAVAILABLE");
      const asset = findAsset(string(raw.assetId), ["image", "video"]);
      const clip = raw.clipId === undefined ? null : [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === string(raw.clipId));
      if (raw.clipId !== undefined && (!clip || clip.blob !== asset.blob || clip.type !== asset.type)) fail("AI_INVALID_SOURCE");
      const quality = raw.quality ?? "balanced";
      if (!["fast", "balanced", "quality"].includes(quality) || raw.inverted !== undefined && typeof raw.inverted !== "boolean") fail("INVALID_ARGUMENT");
      return { request: { ...raw, quality, output, ...(output === "video" ? { inverted: raw.inverted ?? false } : {}) }, source: { assetId: raw.assetId,
        ...(clip ? { clipId: clip.id, sourceStart: clip.sourceStart ?? 0, sourceDuration: clip.sourceDuration ?? clip.duration,
          playbackRate: clip.playbackRate ?? 1, reversed: Boolean(clip.reversed), ...(clip.speedCurve ? { speedCurve: clone(clip.speedCurve) } : {}) } : {}),
        name: String(asset.name || asset.type), type: asset.type, duration: number(clip?.duration ?? (asset.type === "image" ? 3 : asset.duration), 0.05, MAX_TIMELINE_DURATION_SECONDS) },
        downloadPolicy, delivery: output === "analysis" ? "reviewed-native-depth-analysis" : "my-assets-depth-video", timelineInsertion: false, cancellation: "original-depth-worker-and-renderer-abort" };
    }
    if (raw.kind === "nanovsr") {
      object(raw, ["kind", "assetId", "clipId", "frameRate"]);
      if (typeof globalThis.Worker !== "function" || typeof getEditor().commitAiVisualAsset !== "function") fail("AI_UNAVAILABLE");
      const asset = findAsset(string(raw.assetId), ["image", "video"]);
      const clip = [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === string(raw.clipId));
      const source = clip?.enhancement?.mode === "nanovsr-644k" ? clip.enhancement.original : clip;
      if (!clip || clip.type !== asset.type || source?.blob !== asset.blob) fail("AI_INVALID_SOURCE");
      if (asset.type === "image" && raw.frameRate !== undefined) fail("INVALID_ARGUMENT");
      const frameRate = number(raw.frameRate ?? 12, 1, 15);
      if (!Number.isInteger(frameRate)) fail("INVALID_ARGUMENT");
      const sourceStart = asset.type === "video" ? number(source.sourceStart ?? 0, 0, asset.duration) : 0;
      const duration = asset.type === "video" ? number(source.sourceDuration ?? clip.sourceDuration ?? clip.duration * (clip.playbackRate || 1), Number.EPSILON, MAX_TIMELINE_DURATION_SECONDS) : clip.duration;
      if (asset.type === "video" && sourceStart + duration > asset.duration + 0.001) fail("INVALID_ARGUMENT");
      return { request: { ...raw, ...(asset.type === "video" ? { frameRate } : {}) },
        source: { assetId: raw.assetId, clipId: clip.id, name: String(clip.name || asset.name || asset.type), type: asset.type, sourceStart, duration },
        downloadPolicy, delivery: "my-assets-and-reviewed-replacement", timelineInsertion: false, cancellation: "original-NanoVSR-abort" };
    }
    if (raw.kind === "visual_repair") {
      object(raw, ["kind", "assetId", "clipId", "sourceStart", "duration", "playbackRate", "regions"]);
      if (typeof globalThis.Worker !== "function" || typeof getEditor().commitAiVisualAsset !== "function") fail("AI_UNAVAILABLE");
      const asset = findAsset(string(raw.assetId), ["image", "video"]);
      const video = asset.type === "video";
      const clip = raw.clipId === undefined ? null : [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === string(raw.clipId));
      if (raw.clipId !== undefined && (!clip || clip.type !== asset.type || clip.blob !== asset.blob)) fail("AI_INVALID_SOURCE");
      if (!video && ["sourceStart", "duration", "playbackRate"].some(key => raw[key] !== undefined)) fail("INVALID_ARGUMENT");
      const sourceStart = video ? number(raw.sourceStart ?? clip?.sourceStart ?? 0, 0, asset.duration) : 0;
      const playbackRate = video ? number(raw.playbackRate ?? clip?.playbackRate ?? 1, 0.25, 4) : 1;
      const duration = video ? number(raw.duration ?? clip?.sourceDuration ?? (clip ? clip.duration * playbackRate : asset.duration - sourceStart), Number.EPSILON, MAX_TIMELINE_DURATION_SECONDS) : 5;
      if (video && sourceStart + duration > asset.duration) fail("INVALID_ARGUMENT");
      if (video && clip && (clip.speedCurve?.enabled || clip.reversed || clip.reverse || sourceStart !== (clip.sourceStart ?? 0)
        || playbackRate !== (clip.playbackRate ?? 1) || Math.abs(duration - (clip.sourceDuration || clip.duration * playbackRate)) > 0.001)) fail("AI_INVALID_SOURCE");
      validateMiganRegions(raw.regions, video, duration / playbackRate);
      return { request: clone(raw), source: { assetId: raw.assetId, ...(clip ? { clipId: clip.id } : {}), name: String(asset.name || asset.type), type: asset.type, sourceStart, duration, playbackRate },
        downloadPolicy, delivery: clip ? "my-assets-and-reviewed-replacement" : "my-assets", timelineInsertion: false, cancellation: "original-MI-GAN-abort" };
    }
    if (raw.kind === "visual_cutout") {
      object(raw, ["kind", "detectionJobId", "candidateIndex", "assetId", "clipId", "target", "output", "sourceStart", "duration", "flowFps", "anchorFps", "maxSamples", "maxDimension"]);
      if (raw.output !== undefined && !["image", "video"].includes(raw.output)) fail("INVALID_ARGUMENT");
      const video = raw.output === "video";
      const tracking = video ? { flowFps: number(raw.flowFps ?? 8, 1, 30), anchorFps: number(raw.anchorFps ?? 1 / 3.5, 0.1, 30),
        maxSamples: number(raw.maxSamples ?? 360, 2, 3600), maxDimension: number(raw.maxDimension ?? 320, 64, 1024) } : null;
      if (video && (!Number.isInteger(tracking.maxSamples) || !Number.isInteger(tracking.maxDimension)) ||
          !video && [raw.sourceStart, raw.duration, raw.flowFps, raw.anchorFps, raw.maxSamples, raw.maxDimension].some(value => value !== undefined)) fail("INVALID_ARGUMENT");
      if (typeof globalThis.Worker !== "function" || typeof getEditor().commitAiVisualAsset !== "function") fail("AI_UNAVAILABLE");
      if (raw.assetId !== undefined || raw.target !== undefined) {
        if (raw.detectionJobId !== undefined || raw.candidateIndex !== undefined) fail("INVALID_ARGUMENT");
        const asset = findAsset(string(raw.assetId), video ? "video" : "image");
        const clip = raw.clipId === undefined ? null : [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])]
          .find(item => item.id === string(raw.clipId));
        if (raw.clipId !== undefined && (video || !clip || clip.type !== "image" || clip.blob !== asset.blob)) fail("AI_INVALID_SOURCE");
        object(raw.target, ["label", "score", "box"]); string(raw.target.label); number(raw.target.score, 0, 1);
        object(raw.target.box, ["xmin", "ymin", "xmax", "ymax"]);
        for (const key of ["xmin", "ymin", "xmax", "ymax"]) number(raw.target.box[key], 0, 1);
        if (raw.target.box.xmax <= raw.target.box.xmin || raw.target.box.ymax <= raw.target.box.ymin) fail("INVALID_ARGUMENT");
        const sourceStart = video ? number(raw.sourceStart ?? 0, 0, asset.duration) : 0;
        const duration = video ? number(raw.duration ?? asset.duration - sourceStart, Number.EPSILON, asset.duration - sourceStart) : 0;
        return { request: clone(raw), source: { assetId: raw.assetId, ...(clip ? { clipId: clip.id } : {}), name: String(asset.name || "Visual"), sourceTime: sourceStart,
          ...(video ? { type: "video", duration } : {}) }, ...(video ? { tracking } : {}),
          target: clone(raw.target), downloadPolicy, delivery: video ? "my-assets-transparent-video" : "my-assets-transparent-image", timelineInsertion: false,
          cancellation: "original-segmenter-abort" };
      }
      const detection = jobs.get(string(raw.detectionJobId));
      if (detection?.status !== "succeeded" || detection.plan.request.kind !== "visual_detect" || !detection.detectedFrame) fail("AI_JOB_NOT_FOUND");
      if (!Number.isInteger(raw.candidateIndex)) fail("INVALID_ARGUMENT");
      const candidate = detection.result.candidates[number(raw.candidateIndex, 0, 23)];
      if (!candidate) fail("INVALID_ARGUMENT");
      const asset = findAsset(detection.result.assetId, ["image", "video"]);
      if (asset.blob !== detection.detectedFrame.sourceBlob) fail("STALE_STATE");
      const clip = raw.clipId === undefined ? null : [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])]
        .find(item => item.id === string(raw.clipId));
      if (raw.clipId !== undefined && (video || asset.type !== "image" || !clip || clip.type !== "image" || clip.blob !== asset.blob)) fail("AI_INVALID_SOURCE");
      if (video && (asset.type !== "video" || raw.sourceStart !== undefined && raw.sourceStart !== detection.result.sourceTime)) fail("INVALID_ARGUMENT");
      const duration = video ? number(raw.duration ?? asset.duration - detection.result.sourceTime, Number.EPSILON, asset.duration - detection.result.sourceTime) : 0;
      return { request: { ...raw }, source: { assetId: detection.result.assetId, ...(clip ? { clipId: clip.id } : {}), name: String(asset.name || "Visual"),
        sourceTime: detection.result.sourceTime, ...(video ? { type: "video", duration } : {}) }, target: clone(candidate), downloadPolicy,
        ...(video ? { tracking } : {}), delivery: video ? "my-assets-transparent-video" : "my-assets-transparent-image", timelineInsertion: false, cancellation: "original-segmenter-abort" };
    }
    if (raw.kind === "visual_detect") {
      object(raw, ["kind", "assetId", "sourceTime", "scoreThreshold"]);
      if (typeof globalThis.Worker !== "function") fail("AI_UNAVAILABLE");
      const asset = findAsset(string(raw.assetId), ["image", "video"]);
      const sourceTime = number(raw.sourceTime ?? 0, 0, asset.type === "video" ? asset.duration : 0);
      if (asset.type === "video" && sourceTime >= asset.duration) fail("INVALID_ARGUMENT");
      const scoreThreshold = number(raw.scoreThreshold ?? 0.24, 0.01, 0.99);
      return { request: { kind: raw.kind, assetId: raw.assetId, sourceTime, scoreThreshold },
        source: { assetId: raw.assetId, name: String(asset.name || "Visual"), type: asset.type, sourceTime },
        downloadPolicy, delivery: "candidate-boxes", automaticTargetSelection: false, timelineInsertion: false,
        cancellation: "original-detector-abort" };
    }
    if (raw.kind === "voice_convert") {
      object(raw, ["kind", "assetId", "cloneVoiceProfileId", "clipId", "track", "referenceAssetId", "referenceRecordingId", "voiceSourceAuthorized"]);
      if (!browserSupport() || typeof globalThis.Worker !== "function" || typeof getEditor().registerVoiceColorAsset !== "function") fail("AI_UNAVAILABLE");
      if ([raw.cloneVoiceProfileId, raw.referenceAssetId, raw.referenceRecordingId].filter(value => value !== undefined).length !== 1) fail("INVALID_ARGUMENT");
      let profile, reference;
      if (raw.cloneVoiceProfileId !== undefined) {
        if (!getEditor().voiceLibraryReady) fail("EDITOR_BUSY");
        profile = getEditor().voiceProfiles?.find(item => item.id === string(raw.cloneVoiceProfileId));
        if (!profile?.embedding?.length || !Array.from(profile.embedding).every(Number.isFinite)) fail("AI_INVALID_VOICE");
      } else {
        if (raw.voiceSourceAuthorized !== true) fail("INVALID_ARGUMENT");
        reference = findVoiceReference({ assetId: raw.referenceAssetId, recordingId: raw.referenceRecordingId });
      }
      const asset = findAsset(string(raw.assetId));
      if (raw.track !== undefined && !["audio", "source"].includes(raw.track)) fail("INVALID_ARGUMENT");
      if (raw.track === "source") {
        if (raw.clipId !== "source-audio" || getEditor().sourceAudioLinked !== false || getEditor().sourceAudioBlob !== asset.blob) fail("AI_INVALID_SOURCE");
      } else if (raw.clipId !== undefined) {
        const clip = getEditor().audioSegments?.find(item => item.id === string(raw.clipId));
        if (!clip || clip.blob !== asset.blob) fail("AI_INVALID_SOURCE");
      }
      return { request: { ...raw }, source: { assetId: raw.assetId, name: String((raw.track === "source" ? getEditor().sourceAudioName : asset.name) || "Audio"), duration: asset.duration },
        ...(profile ? { cloneProfile: { profileId: profile.id, name: profile.name || "", converter: "OpenVoice V2" } }
          : { reference: { ...(raw.referenceAssetId === undefined ? { recordingId: raw.referenceRecordingId } : { assetId: raw.referenceAssetId }), name: String(reference.name || "Reference voice") } }), downloadPolicy,
        inputRange: "entire-source-blob-as-in-original-voice-color-tool", delivery: "my-assets", timelineInsertion: false,
        cancellation: "discard-after-current-inference" };
    }
    if (raw.kind === "voice_clone_preview") {
      object(raw, ["kind", "assetId", "recordingId", "voiceId", "voiceSourceAuthorized"]);
      if (raw.voiceSourceAuthorized !== true) fail("INVALID_ARGUMENT");
      const voice = VOICES.find(item => item.id === string(raw.voiceId));
      if (!voice) fail("AI_INVALID_VOICE");
      if (!browserSupport(voice) || typeof globalThis.Worker !== "function"
        || typeof getEditor().addVoiceProfile !== "function" || typeof getEditor().commitAiVoiceAssets !== "function") fail("AI_UNAVAILABLE");
      if (!getEditor().voiceLibraryReady) fail("EDITOR_BUSY");
      const reference = findVoiceReference(raw);
      return { request: { ...raw }, source: { ...(raw.recordingId === undefined ? { assetId: raw.assetId } : { recordingId: raw.recordingId }),
        name: String(reference.name || "Reference voice"), duration: reference.duration },
        voice: { voiceId: voice.id, name: voice.name, language: VOICE_LANGUAGES[voice.language] }, downloadPolicy,
        delivery: "my-assets-and-unsaved-voice-profile", timelineInsertion: false, profileSaved: false,
        cancellation: "discard-after-current-inference", saveTool: "timeline_voice_profile_save", draftLifetime: "current-page-job" };
    }
    if (raw.kind === "denoise") {
      object(raw, ["kind", "assetId", "clipId", "preset"]);
      if (typeof globalThis.Worker !== "function" || typeof getEditor().commitAiVisualAsset !== "function") fail("AI_UNAVAILABLE");
      if (!["auto", ...Object.keys(REMASTER_MODE_STRENGTH)].includes(raw.preset)) fail("INVALID_ARGUMENT");
      const asset = findAsset(string(raw.assetId), "video");
      const clip = [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(clip => clip.id === string(raw.clipId));
      const source = clip?.enhancement?.original || clip;
      if (clip?.type !== "video" || source?.blob !== asset.blob) fail("AI_INVALID_SOURCE");
      const sourceStart = number(source.sourceStart ?? 0, 0, asset.duration);
      const duration = number(source.sourceDuration ?? clip.sourceDuration ?? clip.duration, Number.EPSILON, MAX_TIMELINE_DURATION_SECONDS);
      if (sourceStart + duration > asset.duration + 0.001) fail("INVALID_ARGUMENT");
      return { request: { ...raw }, source: { assetId: raw.assetId, clipId: raw.clipId, name: String(clip.name || asset.name || "video"), sourceStart, duration },
        downloadPolicy, modelId: REMASTER_DRUNET_MODEL.id, modelRevision: REMASTER_DRUNET_MODEL.revision,
        delivery: "my-assets-and-reviewed-replacement", timelineInsertion: false, cancellation: "original-renderer-abort" };
    }
    if (raw.kind === "music") {
      object(raw, ["kind", "description", "style", "mood", "instrument", "seconds", "bpm", "timelineOffset"]);
      if (typeof getEditor().generateAiMusic !== "function" || !globalThis.navigator?.gpu || typeof globalThis.Worker !== "function") fail("AI_UNAVAILABLE");
      if (typeof raw.description !== "string" || raw.description.length > 2000 || ![30, 60, 90, 120].includes(raw.seconds)) fail("INVALID_ARGUMENT");
      for (const [key, presets] of Object.entries(AI_MUSIC_PRESETS)) if (!presets.some(([id]) => id === raw[key])) fail("INVALID_ARGUMENT");
      number(raw.bpm, 60, 180);
      if (timelineOffset + raw.seconds > MAX_TIMELINE_DURATION_SECONDS) fail("INVALID_ARGUMENT");
      return { request: { ...raw, timelineOffset }, downloadPolicy, delivery: "my-assets", timelineInsertion: false,
        model: "Stable Audio 3 Small · ONNX", steps: 8, seed: "random", translation: "browser-local-if-needed",
        extendedDuration: raw.seconds > 60 ? "repeat-at-best-boundary" : "none",
        cancellation: "terminate-worker-and-discard-before-asset-registration" };
    }
    if (raw.kind === "voiceover") {
      object(raw, ["kind", "voiceId", "cloneVoiceProfileId", "text", "speed", "gain", "timelineOffset"]);
      const voice = VOICES.find((item) => item.id === string(raw.voiceId));
      if (!voice) fail("AI_INVALID_VOICE");
      let profile;
      if (raw.cloneVoiceProfileId !== undefined) {
        if (typeof globalThis.Worker !== "function") fail("AI_UNAVAILABLE");
        if (!getEditor().voiceLibraryReady) fail("EDITOR_BUSY");
        profile = getEditor().voiceProfiles?.find(item => item.id === string(raw.cloneVoiceProfileId));
        if (!profile?.embedding?.length || !Array.from(profile.embedding).every(Number.isFinite)) fail("AI_INVALID_VOICE");
        if (profile.embeddingVersion !== OPENVOICE_EMBEDDING_VERSION && profile.referenceBlob && typeof getEditor().addVoiceProfile !== "function") fail("AI_UNAVAILABLE");
      }
      if (!browserSupport(voice) || typeof getEditor().commitAiVoiceAssets !== "function") fail("AI_UNAVAILABLE");
      const rawText = string(raw.text, MAX_TEXT).trim();
      const speed = number(raw.speed ?? voice.defaultSpeed ?? 1, 0.7, 1.3);
      // Match the current voice registry: vits-web Piper, Hojo and MMS do not consume speed.
      if (voice.engine !== "kokoro" && voice.engine !== "supertonic" && speed !== 1) fail("INVALID_ARGUMENT");
      const gain = number(raw.gain ?? 1, 0, 4);
      const prepared = prepareTextForVoice(rawText, voice);
      const segments = breathGroups(prepared.text);
      return {
        request: { kind: "voiceover", voiceId: voice.id, ...(profile ? { cloneVoiceProfileId: profile.id } : {}), text: rawText, speed, gain, timelineOffset },
        ...(profile ? { cloneProfile: { profileId: profile.id, name: profile.name || "", converter: "OpenVoice V2" } } : {}),
        spokenText: prepared.text, segments, voice: { voiceId: voice.id, name: voice.name, language: VOICE_LANGUAGES[voice.language] },
        warnings: prepared.warningKey ? [prepared.warningKey] : [], downloadPolicy,
        delivery: "my-assets", suggestedGap: DEFAULT_GENERATED_VOICE_GAP, timelineInsertion: false,
        cancellation: "cooperative-discard-current-segment",
      };
    }
    if (raw.kind === "separation") {
      object(raw, ["kind", "track", "assetId", "clipId", "sourceStart", "duration", "timelineOffset"]);
      if (!browserSupport() || typeof globalThis.Worker !== "function" || typeof getEditor().commitAiVoiceAssets !== "function") fail("AI_UNAVAILABLE");
      if (raw.track === "source") {
        if ([raw.assetId, raw.clipId, raw.sourceStart, raw.duration, raw.timelineOffset].some(value => value !== undefined)) fail("INVALID_ARGUMENT");
        const editor = getEditor();
        if (!(editor.sourceAudioBlob instanceof Blob) || !editor.sourceAudioBlob.size) fail("AI_INVALID_SOURCE");
        const duration = number(editor.sourceAudioDuration, Number.EPSILON, MAX_TIMELINE_DURATION_SECONDS);
        const timelineOffset = number(editor.sourceAudioStart ?? 0, 0, MAX_TIMELINE_DURATION_SECONDS);
        if (timelineOffset + duration > MAX_TIMELINE_DURATION_SECONDS) fail("INVALID_ARGUMENT");
        return { request: { kind: "separation", track: "source", sourceStart: 0, duration, timelineOffset },
          source: { track: "source", name: String(editor.sourceAudioName || "source-audio"), type: "audio", duration,
            linked: editor.sourceAudioLinked !== false }, downloadPolicy,
          timeMapping: "current-shared-source-track", speedCurveMapping: false,
          modelId: "haixin/timeline-studio-vocal-remover", modelRevision: VOCAL_SEPARATION_MODEL_REVISION,
          delivery: "my-assets-with-reviewed-source-and-music-replacement", timelineInsertion: false,
          cancellation: "discard-after-current-inference" };
      }
      if (raw.track !== undefined && raw.track !== "asset") fail("INVALID_ARGUMENT");
      const asset = findAsset(string(raw.assetId), ["audio", "video"]);
      let clip, timing, sourceTrack = "asset";
      if (raw.clipId !== undefined) {
        const clipId = string(raw.clipId);
        const editor = getEditor();
        const audioClip = (editor.audioSegments || []).find(item => item.id === clipId);
        const musicClip = (editor.musicSegments || []).find(item => item.id === clipId);
        const visualClip = (editor.visualSegments || []).find(item => item.id === clipId);
        const overlayClip = (editor.visualOverlaySegments || []).find(item => item.id === clipId);
        const videoClip = visualClip || overlayClip;
        if (videoClip && videoClip.type !== "video") fail("AI_INVALID_SOURCE");
        sourceTrack = audioClip ? "audio" : musicClip ? "music" : visualClip ? "visuals" : "overlays";
        clip = audioClip || musicClip || (videoClip && { ...videoClip,
          start: visualClip ? getVisualSegmentTimeline(editor.visualSegments).find(item => item.id === clipId).start : videoClip.start,
        });
        const clipBlob = clip?.blob || (audioClip ? editor.audioBlob : musicClip ? editor.musicBlob : null);
        if (!clip || clipBlob !== asset.blob) fail("AI_INVALID_SOURCE");
        timing = { duration: number(clip.duration, Number.EPSILON, MAX_TIMELINE_DURATION_SECONDS),
          playbackRate: normalizeVisualPlaybackRate(clip.playbackRate), speedCurve: normalizeVisualSpeedCurve(clip.speedCurve) };
        clip = { ...clip, duration: clip.sourceDuration || timing.duration * timing.playbackRate };
        for (const [key, value] of Object.entries({ sourceStart: clip.sourceStart ?? 0, duration: clip.duration, timelineOffset: clip.start })) {
          if (raw[key] !== undefined && raw[key] !== value) fail("INVALID_ARGUMENT");
        }
      }
      const sourceStart = number(raw.sourceStart ?? clip?.sourceStart ?? 0, 0, asset.duration);
      const duration = number(raw.duration ?? clip?.duration ?? asset.duration - sourceStart, Number.EPSILON, MAX_TIMELINE_DURATION_SECONDS);
      const placementStart = number(raw.timelineOffset ?? clip?.start ?? 0, 0, MAX_TIMELINE_DURATION_SECONDS);
      if (sourceStart + duration > asset.duration + 0.001 || placementStart + (timing?.duration ?? duration) > MAX_TIMELINE_DURATION_SECONDS) fail("INVALID_ARGUMENT");
      return { request: { kind: "separation", assetId: raw.assetId, ...(clip ? { clipId: clip.id } : {}), sourceStart, duration, timelineOffset: placementStart },
        source: { assetId: raw.assetId, name: String(asset.name || ""), type: asset.type, duration: asset.duration, track: sourceTrack, ...(timing ? { timing } : {}) }, downloadPolicy,
        timeMapping: timing ? "pitch-preserved-clip-timing" : "source-range-seconds-plus-timeline-offset", speedCurveMapping: true,
        modelId: "haixin/timeline-studio-vocal-remover", modelRevision: VOCAL_SEPARATION_MODEL_REVISION,
        delivery: "my-assets", timelineInsertion: false, cancellation: "discard-after-current-inference" };
    }
    if (raw.kind === "transcription") {
      object(raw, ["kind", "assetId", "language", "sourceStart", "duration", "timelineOffset"]);
      if (!browserSupport() || typeof globalThis.Worker !== "function") fail("AI_UNAVAILABLE");
      const asset = findAsset(string(raw.assetId));
      const sourceStart = number(raw.sourceStart ?? 0, 0, asset.duration);
      const duration = number(raw.duration ?? Math.min(MAX_TRANSCRIPTION_SECONDS, asset.duration - sourceStart), MIN_CAPTION_SECONDS, MAX_TRANSCRIPTION_SECONDS);
      if (sourceStart + duration > asset.duration + 0.001 || timelineOffset + duration > MAX_TIMELINE_DURATION_SECONDS) fail("INVALID_ARGUMENT");
      const language = raw.language ?? (LANGUAGES.includes(getEditor().language) ? getEditor().language : "en");
      if (!LANGUAGES.includes(language)) fail("INVALID_ARGUMENT");
      return {
        request: { kind: "transcription", assetId: raw.assetId, language, sourceStart, duration, timelineOffset },
        source: { assetId: raw.assetId, name: String(asset.name || ""), duration: asset.duration }, downloadPolicy,
        modelId: AUTOMATIC_CAPTION_MODEL_ID, delivery: "caption.add-operations-for-edit-preview", timelineInsertion: false,
        languageSelection: "automatic-with-preferred-language", timeMapping: "source-range-seconds-plus-timeline-offset",
        cancellation: "terminate-worker-after-audio-decode",
      };
    }
    fail("INVALID_ARGUMENT");
  };
  const finish = (job, status, error) => {
    job.status = status; job.finishedAt = new Date().toISOString();
    if (error) job.error = { code: error, phaseKey: job.phaseKey };
    job.phaseKey = status === "succeeded" ? "aiComplete" : status === "cancelled" ? "aiCancelled" : "aiFailed";
    if (status === "succeeded") job.progress = 100;
    job.detachSignal?.(); job.detachSignal = null;
    job.releaseProcessing?.(); job.releaseProcessing = null;
    if (active === job.jobId) active = null;
    publish(job);
  };
  const lookup = (input) => {
    guard(); object(input, ["jobId"]);
    const job = jobs.get(string(input.jobId));
    if (!job) fail("AI_JOB_NOT_FOUND");
    return job;
  };
  const runVoiceConversion = async (job, sourceBlob, profile, referenceBlob) => {
    let embedding = profile ? Float32Array.from(profile.embedding) : null;
    const [{ convertVoiceBlob, extractVoiceEmbedding }, { decodeWaveform }] = await Promise.all([import("./openVoiceRuntime.js"), import("./media.js")]);
    const signal = job.controller.signal;
    aborted(signal);
    if (!embedding) {
      embedding = await extractVoiceEmbedding(referenceBlob, event => update(job, "aiPreparing", event.progress));
      aborted(signal);
      if (!embedding?.length || !Array.from(embedding).every(Number.isFinite)) fail("AI_FAILED");
    }
    const blob = await convertVoiceBlob(sourceBlob, embedding, { onProgress: event => update(job, "aiSynthesizing", event.progress) });
    aborted(signal);
    const decoded = await decodeWaveform(blob, 96);
    aborted(signal);
    if (!(blob instanceof Blob) || !blob.size || !Number.isFinite(decoded.duration) || decoded.duration <= 0) fail("AI_FAILED");
    update(job, "aiCommitting", null);
    const asset = await getEditor().registerVoiceColorAsset({ blob, decoded, profileName: profile?.name || job.plan.reference?.name || "", sourceName: job.plan.source.name }, { signal });
    if (!asset?.id) fail("AI_FAILED");
    return { delivery: "my-assets", assetIds: [asset.id], duration: decoded.duration, timelineInserted: false };
  };
  const runClonePreview = async (job, referenceBlob) => {
    const [{ synthesizeBaseVoice, getVoiceCloneTestSentence }, { extractVoiceEmbedding, convertVoiceBlob }, { decodeWaveform }] = await Promise.all([
      import("./baseVoiceSynthesis.js"), import("./openVoiceRuntime.js"), import("./media.js"),
    ]);
    const signal = job.controller.signal;
    const voice = VOICES.find(item => item.id === job.plan.request.voiceId);
    aborted(signal);
    const embedding = await extractVoiceEmbedding(referenceBlob, event => update(job, "aiPreparing", event.progress));
    aborted(signal);
    if (!embedding?.length || !Array.from(embedding).every(Number.isFinite)) fail("AI_FAILED");
    const text = getVoiceCloneTestSentence(voice);
    const { blob: baseBlob } = await synthesizeBaseVoice({ voice, text, speed: 1,
      onProgress: progress => update(job, "aiSynthesizing", progress) });
    aborted(signal);
    const testBlob = await convertVoiceBlob(baseBlob, embedding, { onProgress: event => update(job, "aiSynthesizing", event.progress) });
    aborted(signal);
    const decoded = await decodeWaveform(testBlob, 96);
    aborted(signal);
    if (!(testBlob instanceof Blob) || !testBlob.size || !(decoded.duration > 0) || !Number.isFinite(decoded.duration)) fail("AI_FAILED");
    update(job, "aiCommitting", null);
    const assets = await getEditor().commitAiVoiceAssets({ items: [{ blob: testBlob, decoded, name: `${job.plan.source.name} · Clone preview`, voiceId: voice.id, text }], voiceId: voice.id, text }, { signal });
    if (!Array.isArray(assets) || assets.length !== 1 || !assets[0]?.id) fail("AI_FAILED");
    // Keep source media and the derived embedding private until the separate save action.
    job.profileDraft = { referenceBlob, testBlob, embedding: Float32Array.from(embedding) };
    return { delivery: "my-assets-and-unsaved-voice-profile", assetIds: [assets[0].id], duration: decoded.duration,
      profileSaved: false, saveTool: "timeline_voice_profile_save", draftLifetime: "current-page-job", timelineInserted: false };
  };
  const runVoiceover = async (job, profile) => {
    const [{ synthesizeBaseVoice }, { applyVoiceOutputGain, extractVoiceEmbedding, convertVoiceBlob }, { decodeWaveform }] = await Promise.all([
      import("./baseVoiceSynthesis.js"), import("./openVoiceRuntime.js"), import("./media.js"),
    ]);
    const { request, segments } = job.plan;
    const voice = VOICES.find((item) => item.id === request.voiceId);
    let targetEmbedding = profile ? Float32Array.from(profile.embedding) : null;
    if (profile && profile.embeddingVersion !== OPENVOICE_EMBEDDING_VERSION && profile.referenceBlob) {
      aborted(job.controller.signal);
      targetEmbedding = await extractVoiceEmbedding(profile.referenceBlob, event => update(job, "aiPreparing", event.progress));
      aborted(job.controller.signal);
      if (getEditor().voiceProfiles?.find(item => item.id === profile.id) !== profile) fail("STALE_STATE");
      await getEditor().addVoiceProfile({ ...profile, embedding: Float32Array.from(targetEmbedding), embeddingVersion: OPENVOICE_EMBEDDING_VERSION, updatedAt: new Date().toISOString() });
      aborted(job.controller.signal);
    }
    const items = [];
    for (let index = 0; index < segments.length; index += 1) {
      aborted(job.controller.signal);
      const segment = { current: index + 1, total: segments.length };
      update(job, "aiSynthesizing", null, segment);
      let { blob } = await synthesizeBaseVoice({
        voice, text: segments[index], speed: request.speed,
        onProgress: (progress) => update(job, job.phaseKey, progress, segment),
        onStatus: (key) => update(job, key.includes("Generating") ? "aiSynthesizing" : "aiPreparing", null, segment),
      });
      aborted(job.controller.signal);
      if (targetEmbedding) {
        blob = await convertVoiceBlob(blob, targetEmbedding, { seed: 2026 + index,
          onProgress: event => update(job, "aiSynthesizing", event.progress, segment) });
        aborted(job.controller.signal);
      }
      blob = await applyVoiceOutputGain(blob, request.gain);
      aborted(job.controller.signal);
      update(job, "aiDecoding", null, segment);
      const decoded = await decodeWaveform(blob, 96);
      aborted(job.controller.signal);
      if (!(blob instanceof Blob) || !blob.size || !Number.isFinite(decoded.duration) || decoded.duration <= 0) fail("AI_FAILED");
      items.push({ blob, decoded, name: `${profile?.name || voice.name} · ${index + 1}`, voiceId: voice.id, text: segments[index],
        ...(profile ? { sourceKind: "cloned-voiceover", cloneVoiceProfileId: profile.id, cloneVoiceProfileName: profile.name || "" } : {}) });
    }
    if (request.timelineOffset + items.reduce((total, item) => total + item.decoded.duration, 0)
      + Math.max(0, items.length - 1) * DEFAULT_GENERATED_VOICE_GAP > MAX_TIMELINE_DURATION_SECONDS) fail("INVALID_ARGUMENT");
    update(job, "aiCommitting", null);
    aborted(job.controller.signal);
    // The host checks this signal immediately before its single synchronous
    // state commit. Until then a cancellation discards every staged sentence.
    const assets = await getEditor().commitAiVoiceAssets({ items, voiceId: voice.id, text: request.text }, { signal: job.controller.signal });
    if (!Array.isArray(assets) || assets.length !== items.length || assets.some((asset) => !asset?.id)) fail("AI_FAILED");
    let cursor = request.timelineOffset;
    const placements = assets.map((asset, index) => {
      const duration = items[index].decoded.duration;
      const placement = { assetId: asset.id, start: cursor, duration, text: items[index].text };
      cursor += duration + DEFAULT_GENERATED_VOICE_GAP;
      return placement;
    });
    return {
      delivery: "my-assets", assetIds: assets.map((asset) => asset.id), placements,
      duration: placements.reduce((total, item) => total + item.duration, 0),
      suggestedGap: DEFAULT_GENERATED_VOICE_GAP, suggestedEnd: cursor - DEFAULT_GENERATED_VOICE_GAP,
      timelineInserted: false,
    };
  };
  const runTranscription = async (job, sourceBlob) => {
    const [{ sliceAudioBlob }, { transcribeAudioToCaptionSegments }] = await Promise.all([import("./media.js"), import("./asr.js")]);
    const request = job.plan.request;
    aborted(job.controller.signal); update(job, "aiDecoding", null);
    const blob = await sliceAudioBlob(sourceBlob, request.sourceStart, request.duration);
    aborted(job.controller.signal); update(job, "aiTranscribing", null);
    const result = await transcribeAudioToCaptionSegments(blob, {
      preferredLanguage: request.language, timelineOffset: request.timelineOffset,
      signal: job.controller.signal, requireWorker: true,
      onProgress: ({ progress, phase }) => update(job, /下载|初始化/.test(phase) ? "aiPreparing" : /解码/.test(phase) ? "aiDecoding" : "aiTranscribing", progress),
    });
    aborted(job.controller.signal);
    const rangeEnd = Math.min(MAX_TIMELINE_DURATION_SECONDS, request.timelineOffset + result.duration);
    const rawCaptions = result.segments.map((segment) => ({
      clipId: `ai-caption-${makeId()}`, text: segment.text,
      start: Math.max(request.timelineOffset, segment.start), end: Math.min(rangeEnd, segment.end),
    })).filter((segment) => segment.end > segment.start);
    // Whisper may emit a word clipped to the last few samples. Keep its words
    // by merging adjacent short fragments rather than returning an operation
    // that the shared caption command's 0.2-second minimum would reject.
    const captions = [];
    for (const caption of rawCaptions) {
      const previous = captions.at(-1);
      if (previous && (previous.end - previous.start < MIN_CAPTION_SECONDS || caption.end - caption.start < MIN_CAPTION_SECONDS)) {
        const separator = ["zh", "ja"].includes(result.language) ? "" : " ";
        previous.text = `${previous.text}${separator}${caption.text}`;
        previous.end = Math.max(previous.end, caption.end);
      } else captions.push(caption);
    }
    if (captions.some((caption) => caption.end - caption.start < MIN_CAPTION_SECONDS - 1e-9)) fail("AI_FAILED");
    if (!captions.length || captions.length > 500) fail("AI_FAILED");
    return {
      delivery: "caption.add-operations-for-edit-preview", assetId: request.assetId,
      language: result.language, languageDetected: result.languageDetected, text: result.text,
      duration: result.duration, captions, operations: captions.map((caption) => ({ type: "caption.add", ...caption })),
      timelineInserted: false,
    };
  };
  const runDenoise = async (job, sourceBlob) => {
    const { enhanceRemasterClip } = await import("./remasterClipEnhancement.js");
    aborted(job.controller.signal);
    const src = URL.createObjectURL(sourceBlob);
    try {
      const enhanced = await enhanceRemasterClip({
        segment: { type: "video", src, blob: sourceBlob, sourceStart: job.plan.source.sourceStart, sourceDuration: job.plan.source.duration },
        frameRate: 0, maxLongEdge: 960, strength: job.plan.request.preset === "auto" ? "auto" : REMASTER_MODE_STRENGTH[job.plan.request.preset],
        signal: job.controller.signal, onProgress: ({ progress }) => update(job, "aiSynthesizing", progress),
      });
      aborted(job.controller.signal);
      if (!(enhanced.blob instanceof Blob) || !enhanced.blob.size || !(enhanced.width > 0) || !(enhanced.height > 0)
        || !Number.isFinite(enhanced.sourceDuration) || Math.abs(enhanced.sourceDuration - job.plan.source.duration) > 0.001) fail("AI_FAILED");
      const asset = await getEditor().commitAiVisualAsset({ ...enhanced, name: `${job.plan.source.name} · Remaster` }, { signal: job.controller.signal });
      if (!asset?.id) fail("AI_FAILED");
      const processing = { preset: job.plan.request.preset, strength: enhanced.strength, analysis: enhanced.analysis, backend: enhanced.backend,
        pipeline: enhanced.pipeline, frameRate: enhanced.frameRate, reusedFrames: enhanced.reusedFrames, audioPreserved: enhanced.audioPreserved };
      return { delivery: "my-assets-and-reviewed-replacement", assetIds: [asset.id],
        operations: [{ type: "clip.apply_enhancement", clipId: job.plan.request.clipId, assetId: asset.id, mode: "smart-denoise-drunet", processing }],
        processing, timelineInserted: false };
    } finally { URL.revokeObjectURL(src); }
  };
  const runSeparation = async (job, sourceBlob, sourceClip) => {
    const [{ separateVocals }, { sliceAudioBlob, decodeWaveform, extractAudioFromVideo }] = await Promise.all([import("./vocalSeparation.js"), import("./media.js")]);
    const { request } = job.plan;
    const assertSourceTrack = () => {
      const editor = getEditor();
      if (request.track === "source") {
        if (editor.sourceAudioBlob !== sourceBlob || editor.sourceAudioDuration !== request.duration
          || (editor.sourceAudioStart ?? 0) !== request.timelineOffset
          || (editor.sourceAudioLinked !== false) !== job.plan.source.linked) fail("STALE_STATE");
        return;
      }
      if (sourceClip) {
        const key = { audio: "audioSegments", music: "musicSegments", visuals: "visualSegments", overlays: "visualOverlaySegments" }[job.plan.source.track];
        if (editor[key]?.find(item => item.id === request.clipId) !== sourceClip) fail("STALE_STATE");
      }
    };
    aborted(job.controller.signal); update(job, "aiDecoding", null);
    const audioBlob = job.plan.source.type === "video" ? await extractAudioFromVideo(sourceBlob, job.plan.source.name || "source-video.mp4") : sourceBlob;
    aborted(job.controller.signal);
    const blob = await sliceAudioBlob(audioBlob, request.sourceStart, request.duration);
    aborted(job.controller.signal);
    const stems = await separateVocals(blob, progress => update(job, "aiSynthesizing", progress));
    aborted(job.controller.signal);
    assertSourceTrack();
    const timing = job.plan.source.timing;
    const retime = timing && (timing.speedCurve.enabled || Math.abs(timing.playbackRate - 1) > 0.0001 || Math.abs(timing.duration - request.duration) > 0.001);
    const exportAudioClip = retime ? (await import("./audioExport.js")).exportAudioClip : null;
    const items = await Promise.all(["vocals", "accompaniment"].map(async stem => {
      let blob = stems[stem];
      if (retime) {
        aborted(job.controller.signal);
        blob = (await exportAudioClip({ segment: { ...timing, sourceStart: 0, sourceDuration: request.duration, blob, volume: 1 },
          signal: job.controller.signal, format: "wav" })).blob;
      }
      aborted(job.controller.signal);
      const decoded = await decodeWaveform(blob, 96);
      if (!(blob instanceof Blob) || !blob.size || !Number.isFinite(decoded.duration) || decoded.duration <= 0
        || request.timelineOffset + decoded.duration > MAX_TIMELINE_DURATION_SECONDS) fail("AI_FAILED");
      return { blob, decoded, kind: stem === "vocals" ? "voiceover" : "music", name: `${job.plan.source.name} · ${stem}` };
    }));
    aborted(job.controller.signal); update(job, "aiCommitting", null);
    assertSourceTrack();
    const assets = await getEditor().commitAiVoiceAssets({ items }, { signal: job.controller.signal });
    if (!Array.isArray(assets) || assets.length !== 2 || assets.some(asset => !asset?.id)) fail("AI_FAILED");
    if (request.track === "source") {
      return { delivery: "my-assets-and-reviewed-source-routing", assetIds: assets.map(asset => asset.id), backend: stems.backend,
        operations: [
          { type: "source.replace_audio", assetId: assets[0].id },
          { type: "track.replace_music", assetId: assets[1].id, clipId: makeId(), start: request.timelineOffset, duration: items[1].decoded.duration },
        ], timelineInserted: false };
    }
    if (job.plan.source.track === "audio") {
      return { delivery: "my-assets-and-reviewed-clip-routing", assetIds: assets.map(asset => asset.id), backend: stems.backend,
        operations: [
          { type: "audio.replace_source", clipId: request.clipId, assetId: assets[0].id },
          { type: "track.replace_music", assetId: assets[1].id, clipId: makeId(), start: request.timelineOffset, duration: items[1].decoded.duration },
        ], timelineInserted: false };
    }
    if (job.plan.source.track === "music") {
      return { delivery: "my-assets-and-reviewed-clip-routing", assetIds: assets.map(asset => asset.id), backend: stems.backend,
        operations: [{ type: "track.replace_music", assetId: assets[1].id, clipId: makeId(), start: request.timelineOffset, duration: items[1].decoded.duration }],
        placements: [{ assetId: assets[0].id, start: request.timelineOffset, duration: items[0].decoded.duration, track: "audio" }], timelineInserted: false };
    }
    return { delivery: "my-assets", assetIds: assets.map(asset => asset.id), backend: stems.backend,
      placements: assets.map((asset, index) => ({ assetId: asset.id, start: request.timelineOffset, duration: items[index].decoded.duration, track: index === 0 ? "audio" : "music" })),
      timelineInserted: false };
  };
  const runMusic = async (job) => {
    const { kind: _kind, timelineOffset, ...selection } = job.plan.request;
    const result = await getEditor().generateAiMusic(selection, {
      signal: job.controller.signal,
      onProgress: ({ progress }) => update(job, "aiSynthesizing", Number.isFinite(progress) ? progress * 100 : null),
    });
    if (result?.status !== "succeeded") {
      aborted(job.controller.signal);
      if (result?.status === "cancelled") throw new DOMException("Cancelled", "AbortError");
      fail(result?.status === "busy" ? "EDITOR_BUSY" : "AI_FAILED");
    }
    if (!result.asset?.id || !(result.asset.duration > 0)) fail("AI_FAILED");
    if (timelineOffset + result.asset.duration > MAX_TIMELINE_DURATION_SECONDS) fail("INVALID_ARGUMENT");
    return { delivery: "my-assets", assetIds: [result.asset.id], duration: result.asset.duration,
      placements: [{ assetId: result.asset.id, start: timelineOffset, duration: result.asset.duration }], timelineInserted: false };
  };
  const runPauseDetection = async (job, clip) => {
    const { signal } = job.controller;
    const { analyzeVideoPauses } = await import("./sileroVad.js");
    aborted(signal);
    const segments = getEditor().visualSegments || [];
    const index = segments.findIndex(item => item.id === clip.id);
    if (segments[index] !== clip) fail("STALE_STATE");
    if (!canRemovePauses(clip, segments[index - 1])) fail("AI_INVALID_SOURCE");
    const probabilities = await analyzeVideoPauses(clip, { signal, language: getEditor().language,
      onProgress: (progress, phase) => update(job, phase, Number.isFinite(progress) ? progress * 100 : null) });
    aborted(signal);
    if (getEditor().visualSegments?.find(item => item.id === clip.id) !== clip) fail("STALE_STATE");
    const candidates = findPauseCandidates(probabilities, clip, job.plan.request);
    job.pauseClip = clip;
    return { delivery: "pause-candidates", clipId: clip.id, assetId: job.plan.request.assetId,
      clipDuration: clip.duration, modelSha256: SILERO_MODEL_SHA256,
      coordinates: "clip-local-timeline-seconds", minimum: job.plan.request.minimum, keep: job.plan.request.keep,
      candidates, timelineInserted: false };
  };
  const runVisualDetection = async (job, sourceBlob) => {
    const { signal } = job.controller;
    const { assetId, sourceTime, scoreThreshold } = job.plan.request;
    const [{ captureVisualFrame }, { detectObjectsWithNanoDet }] = await Promise.all([import("./vision.js"), import("./objectSegmentation.js")]);
    aborted(signal);
    const blob = await captureVisualFrame({ src: sourceBlob, type: job.plan.source.type, time: sourceTime,
      maxDimension: 1024, outputType: "image/png", signal });
    aborted(signal);
    const result = await detectObjectsWithNanoDet({ blob, signal, scoreThreshold,
      onProgress: ({ progress }) => update(job, "aiPreparing", progress) });
    aborted(signal);
    if (findAsset(assetId, ["image", "video"]).blob !== sourceBlob) fail("STALE_STATE");
    job.detectedFrame = { blob, sourceBlob };
    return { delivery: "candidate-boxes", assetId, sourceTime, sourceType: job.plan.source.type, sourceSize: result.sourceSize,
      modelId: result.modelId, modelPath: result.modelPath, coordinates: "normalized-source-frame",
      candidates: result.detections.map((item, index) => ({ candidateIndex: index, label: item.label, score: item.score, box: item.box })),
      automaticTargetSelection: false, timelineInserted: false };
  };
  const runAudioReverse = async (job, targetClip) => {
    const { signal } = job.controller, { request, source } = job.plan;
    const [{ prepareAudioSegmentReverse }, { decodeWaveform }] = await Promise.all([import("./audioClipActions.js"), import("./media.js")]);
    aborted(signal);
    const result = await prepareAudioSegmentReverse(targetClip, request.reversed, { signal });
    const decoded = await decodeWaveform(result.blob);
    aborted(signal);
    if (getEditor().audioSegments?.find(item => item.id === request.clipId) !== targetClip) fail("STALE_STATE");
    if (!(decoded.duration > 0) || !Number.isFinite(decoded.duration)) fail("AI_FAILED");
    update(job, "aiCommitting", null);
    const assets = await getEditor().commitAiVoiceAssets({ items: [{ blob: result.blob, decoded,
      name: `${source.name} · ${request.reversed ? "Reverse" : "Original"}` }] }, { signal });
    if (!Array.isArray(assets) || assets.length !== 1 || !assets[0]?.id) fail("AI_FAILED");
    return { delivery: job.plan.delivery, assetIds: [assets[0].id], source, timelineInserted: false,
      operations: [{ type: "audio.apply_reverse", clipId: request.clipId, assetId: assets[0].id, reversed: request.reversed }] };
  };
  const runSourceAudioExtraction = async (job, sourceBlob, targetClip) => {
    const { signal } = job.controller, { source } = job.plan;
    const [{ extractAudioFromVideo, sliceAudioBlob, decodeWaveform }, { exportAudioClip }] = await Promise.all([
      import("./media.js"), import("./audioExport.js"),
    ]);
    aborted(signal); update(job, "aiDecoding", null);
    const extracted = targetClip.compatibilityAudioBlob instanceof Blob && targetClip.compatibilityAudioBlob.size
      ? targetClip.compatibilityAudioBlob
      : await extractAudioFromVideo(sourceBlob, source.name || "source-video.mp4");
    aborted(signal);
    let blob = await sliceAudioBlob(extracted, source.sourceStart, source.sourceDuration);
    aborted(signal);
    const { timing } = source;
    if (timing.speedCurve.enabled || Math.abs(timing.playbackRate - 1) > 0.0001
      || Math.abs(timing.duration - source.sourceDuration) > 0.001) {
      blob = (await exportAudioClip({ segment: { ...timing, sourceStart: 0, sourceDuration: source.sourceDuration,
        blob, volume: 1 }, signal, format: "wav" })).blob;
    }
    aborted(signal);
    const decoded = await decodeWaveform(blob, 96);
    aborted(signal);
    if (getEditor()[source.track === "visuals" ? "visualSegments" : "visualOverlaySegments"]?.find(item => item.id === source.clipId) !== targetClip
      || findAsset(source.assetId, "video").blob !== sourceBlob) fail("STALE_STATE");
    if (!(blob instanceof Blob) || !blob.size || !(decoded.duration > 0) || !Number.isFinite(decoded.duration)
      || Math.abs(decoded.duration - timing.duration) > 0.08 || source.start + decoded.duration > MAX_TIMELINE_DURATION_SECONDS) fail("AI_FAILED");
    update(job, "aiCommitting", null);
    const assets = await getEditor().commitAiVoiceAssets({ items: [{ blob, decoded, name: `${source.name} · Source audio`,
      sourceKind: source.track === "overlays" ? "overlay-video-audio" : "main-video-audio" }] }, { signal });
    if (!Array.isArray(assets) || assets.length !== 1 || !assets[0]?.id) fail("AI_FAILED");
    return { delivery: job.plan.delivery, assetIds: [assets[0].id], source,
      placements: [{ assetId: assets[0].id, start: source.start, duration: decoded.duration, track: "audio" }],
      operations: [{ type: "clip.set_muted", clipId: source.clipId, muted: true }], timelineInserted: false };
  };
  const runSmartFrame = async (job, sourceBlob, targetClip) => {
    const { signal } = job.controller, { source, target, settings } = job.plan;
    const [{ analyzeSmartFrameClip }, { buildSmartFrameRecord, normalizeSmartFrame }] = await Promise.all([
      import("./smartFrameAnalysis.js"), import("./smartFrame.js"),
    ]);
    aborted(signal);
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const analysis = await analyzeSmartFrameClip({ segment: { ...targetClip, blob: sourceBlob }, signal,
      onProgress: ({ stage, progress }) => update(job, stage === "setup" ? "aiPreparing" : "aiSynthesizing", progress) });
    aborted(signal);
    if (findAsset(source.assetId, ["image", "video"]).blob !== sourceBlob
      || getEditor()[source.track === "visuals" ? "visualSegments" : "visualOverlaySegments"]?.find(item => item.id === source.clipId) !== targetClip) fail("STALE_STATE");
    const analysisMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - startedAt);
    const smartFrame = normalizeSmartFrame(buildSmartFrameRecord({ ...analysis, analysisMs,
      targetSize: { width: target.width, height: target.height }, targetRatio: target.ratio,
      segment: { ...targetClip, assetId: source.assetId }, settings }));
    if (!smartFrame) fail("AI_FAILED");
    return { delivery: job.plan.delivery, source, target, settings,
      operations: [{ type: "project.set_ratio", ratio: target.ratio },
        { type: "clip.apply_smart_frame", clipId: source.clipId, sourceAssetId: source.assetId, smartFrame }],
      stats: smartFrame.stats, timelineInserted: false };
  };
  const runCaptionAvoidance = async (job, sourceBlob, targetClip) => {
    const { signal } = job.controller, { source } = job.plan;
    const { analyzeSmartFrameClip } = await import("./smartFrameAnalysis.js");
    aborted(signal);
    const analysis = await analyzeSmartFrameClip({ segment: { ...targetClip, blob: sourceBlob }, signal,
      onProgress: ({ stage, progress }) => update(job, stage === "setup" ? "aiPreparing" : "aiSynthesizing", progress) });
    aborted(signal);
    if (findAsset(source.assetId, ["image", "video"]).blob !== sourceBlob
      || getEditor()[source.track === "visuals" ? "visualSegments" : "visualOverlaySegments"]?.find(item => item.id === source.clipId) !== targetClip) fail("STALE_STATE");
    const sourceSignature = { assetId: source.assetId, sourceStart: source.sourceStart,
      sourceDuration: source.sourceDuration, playbackRate: source.playbackRate };
    const normalized = source.type === "video" ? {
      kind: "video-timeline", complete: true, visualType: "video", sourceSize: analysis.sourceSize,
      duration: source.sourceStart + source.sourceDuration, samples: analysis.samples,
    } : {
      kind: "image-subject", complete: true, visualType: "image", sourceSize: analysis.sourceSize,
      subject: analysis.samples?.[0]?.subject || null,
    };
    if (!(normalized.sourceSize?.width > 0) || !(normalized.sourceSize?.height > 0)
      || (source.type === "video" ? !normalized.samples?.some(sample => sample.subject?.box) : !normalized.subject?.box)) fail("AI_FAILED");
    const captionAnalysis = { ...normalized, sourceSignature, modelId: YOLOS_TINY_MODEL_ID,
      modelRevision: analysis.modelRevision || YOLOS_TINY_MODEL_REVISION,
      runtimeBackend: analysis.runtimeBackend || "unknown", options: { avoidCaptions: true } };
    return { delivery: job.plan.delivery, source, analysis: captionAnalysis,
      operations: [{ type: "clip.apply_caption_avoidance", clipId: source.clipId,
        sourceAssetId: source.assetId, analysis: captionAnalysis }], timelineInserted: false };
  };
  const runAvatar = async (job, sourceBlob, referenceBlob) => {
    const { signal } = job.controller, { request, source } = job.plan;
    const { generateAvatarAsset } = await import("../hooks/useAvatarGeneration.js");
    aborted(signal);
    const result = await generateAvatarAsset({ portrait: sourceBlob, audio: referenceBlob, portraitKey: source.assetId,
      language: source.language, quality: request.quality, duration: request.duration, renderFps: request.renderFps, neuralFps: request.neuralFps,
      signal, onProgress: ({ progress }) => update(job, "aiSynthesizing", progress) });
    aborted(signal);
    if (findAsset(source.assetId, "image").blob !== sourceBlob || findAsset(request.referenceAssetId).blob !== referenceBlob) fail("STALE_STATE");
    if (!(result.blob instanceof Blob) || !result.blob.size || !(result.width > 0) || !(result.height > 0) ||
        !Number.isFinite(result.duration) || Math.abs(result.duration - request.duration) > 0.05) fail("AI_FAILED");
    const asset = await getEditor().commitAiVisualAsset({ ...result, type: "video", sourceDuration: result.duration,
      name: `${source.name} · JoyVASA + LivePortrait` }, { signal });
    if (!asset?.id) fail("AI_FAILED");
    return { delivery: job.plan.delivery, assetIds: [asset.id], source, audioIncluded: false, timelineInserted: false };
  };
  const runAutoCaption = async (job, bindings) => {
    const { signal } = job.controller, { request, source } = job.plan;
    const { probeBuiltInAI, extractAutoEditFrames, createFrameCaptionSession, createAutoEditTranslator, generateFrameCaptions } = await import("./autoEdit.js");
    const environment = await probeBuiltInAI(request.language);
    aborted(signal);
    if (environment.availability !== "available") fail("AI_UNAVAILABLE");
    let session, translator;
    const urls = [];
    const segments = bindings.map(binding => {
      const blob = binding.media instanceof Blob ? binding.media : undefined;
      const src = blob ? URL.createObjectURL(blob) : binding.media;
      if (blob) urls.push(src);
      return { ...binding.clip, src, ...(blob ? { blob } : {}) };
    });
    try {
      session = await createFrameCaptionSession({ language: request.language, signal });
      translator = await createAutoEditTranslator({ language: request.language, signal });
      aborted(signal);
      const frames = await extractAutoEditFrames(segments, progress => update(job, "aiSynthesizing", progress), signal);
      const captions = await generateFrameCaptions({ frames, duration: source.duration, language: request.language, session, translator, signal,
        onPartial: partial => update(job, "aiSynthesizing", 60 + (partial.allWindows ? partial.completedWindows / partial.allWindows : 0) * 35) });
      aborted(signal);
      assertAutoCaptionBindings(bindings);
      if (!captions.length || captions.length > 500) fail("AI_FAILED");
      const mainClipIds = new Set(bindings.filter(binding => binding.source.track === "visuals").map(binding => binding.source.clipId));
      const operations = captions.map(caption => {
        if (typeof caption.text !== "string" || !caption.text.trim() || !Number.isFinite(caption.start) || !Number.isFinite(caption.end) ||
            caption.start < 0 || caption.end > source.duration || caption.end - caption.start < MIN_CAPTION_SECONDS - 1e-9) fail("AI_FAILED");
        const visualClipId = source.scope === "project" ? caption.visualSegmentId : bindings[0].source.track === "visuals" ? bindings[0].source.clipId : null;
        if (visualClipId && !mainClipIds.has(visualClipId)) fail("AI_FAILED");
        const timelineOffset = source.scope === "project" ? 0 : source.timelineOffset;
        return { type: "caption.add", clipId: makeId(), text: caption.text, start: timelineOffset + caption.start,
          end: timelineOffset + caption.end, ...(visualClipId ? { visualClipId } : {}) };
      });
      return { delivery: job.plan.delivery, source, language: request.language, operations, timelineInserted: false };
    } finally { session?.destroy?.(); translator?.destroy?.(); urls.forEach(url => URL.revokeObjectURL(url)); }
  };
  const runDepthMap = async (job, sourceBlob, targetClip) => {
    const { signal } = job.controller, { request, source } = job.plan;
    const { generateDepthMapAsset, generateDepthAnalysis } = await import("../hooks/useDepthOfFieldAnalysis.js");
    aborted(signal);
    const src = URL.createObjectURL(sourceBlob);
    try {
      const segment = { ...(targetClip || { type: source.type, duration: source.duration, sourceStart: 0, sourceDuration: source.duration }), blob: sourceBlob, src };
      if (request.output === "analysis") {
        const generated = await generateDepthAnalysis({ segment, quality: request.quality, signal,
          onProgress: ({ progress }) => update(job, "aiSynthesizing", progress) });
        try {
          aborted(signal);
          if (findAsset(source.assetId, ["image", "video"]).blob !== sourceBlob ||
            [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === targetClip.id) !== targetClip) fail("STALE_STATE");
          const analysis = { ...generated.analysis, signature: getDepthAnalysisSignature({ ...targetClip, src: "" }, request.quality) };
          getEditor().retainDepthAnalysis(analysis);
          return { delivery: job.plan.delivery, source, quality: request.quality, timelineInserted: false,
            operations: [{ type: "clip.apply_depth_analysis", clipId: targetClip.id, sourceAssetId: source.assetId, analysis }] };
        } catch (error) { generated.dispose(); throw error; }
      }
      const result = await generateDepthMapAsset({ segment, quality: request.quality, inverted: request.inverted, signal,
        onProgress: ({ progress }) => update(job, "aiSynthesizing", progress) });
      aborted(signal);
      if (findAsset(source.assetId, ["image", "video"]).blob !== sourceBlob || targetClip &&
          [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === targetClip.id) !== targetClip) fail("STALE_STATE");
      if (!(result.blob instanceof Blob) || !result.blob.size || !(result.width > 0) || !(result.height > 0) || !Number.isFinite(result.duration) || Math.abs(result.duration - source.duration) > 0.05) fail("AI_FAILED");
      const asset = await getEditor().commitAiVisualAsset({ ...result, type: "video", name: `${source.name} · Depth Anything V2`, sourceDuration: result.duration }, { signal });
      if (!asset?.id) fail("AI_FAILED");
      return { delivery: job.plan.delivery, assetIds: [asset.id], source, quality: request.quality, inverted: request.inverted, timelineInserted: false };
    } finally { URL.revokeObjectURL(src); }
  };
  const runNanoVsr = async (job, sourceBlob, targetClip) => {
    const { restoreNanoVsrImage, restoreNanoVsrVideo } = await import("./nanovsr.js");
    const { signal } = job.controller;
    aborted(signal);
    const src = URL.createObjectURL(sourceBlob);
    try {
      const { source, request } = job.plan;
      const restore = source.type === "video" ? restoreNanoVsrVideo : restoreNanoVsrImage;
      const result = await restore({ segment: { type: source.type, src, blob: sourceBlob, sourceStart: source.sourceStart, sourceDuration: source.duration },
        ...(source.type === "video" ? { frameRate: request.frameRate } : {}), signal,
        onProgress: message => update(job, "aiSynthesizing", message.progress ?? (message.value || 0) * 100) });
      aborted(signal);
      if (findAsset(source.assetId, ["image", "video"]).blob !== sourceBlob
        || [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === request.clipId) !== targetClip) fail("STALE_STATE");
      if (!(result.blob instanceof Blob) || !result.blob.size || !(result.width > 0) || !(result.height > 0)
        || source.type === "video" && (!Number.isFinite(result.sourceDuration) || Math.abs(result.sourceDuration - source.duration) > 0.001
          || result.frameRate !== request.frameRate || !Number.isSafeInteger(result.totalFrames) || result.totalFrames < 1)) fail("AI_FAILED");
      const asset = await getEditor().commitAiVisualAsset({ ...result, type: source.type, name: `${source.name} · NanoVSR`, sourceDuration: source.duration }, { signal });
      if (!asset?.id) fail("AI_FAILED");
      const processing = { backend: result.backend || "webgpu", ...(source.type === "video" ? { frameRate: result.frameRate, totalFrames: result.totalFrames } : {}) };
      return { delivery: job.plan.delivery, assetIds: [asset.id], processing, timelineInserted: false,
        operations: [{ type: "clip.apply_enhancement", clipId: request.clipId, assetId: asset.id, mode: "nanovsr-644k", processing }] };
    } finally { URL.revokeObjectURL(src); }
  };
  const runVisualRepair = async (job, sourceBlob, repairClip) => {
    const { signal } = job.controller;
    const { source, request } = job.plan;
    const onProgress = ({ progress }) => update(job, "aiSynthesizing", progress);
    let result;
    aborted(signal);
    if (source.type === "video") {
      const { repairMiganClip } = await import("./miganClipRepair.js");
      aborted(signal);
      const src = URL.createObjectURL(sourceBlob);
      try {
        result = await repairMiganClip({ segment: { type: "video", src, blob: sourceBlob, sourceStart: source.sourceStart,
          sourceDuration: source.duration, duration: source.duration / source.playbackRate, playbackRate: source.playbackRate },
        regions: request.regions, signal, onProgress });
      } finally { URL.revokeObjectURL(src); }
      if (!Number.isFinite(result.sourceDuration) || Math.abs(result.sourceDuration - source.duration) > 0.001) fail("AI_FAILED");
    } else {
      const { repairMiganFrame } = await import("./miganRepair.js");
      let blob = sourceBlob;
      for (const region of request.regions) {
        aborted(signal);
        const bitmap = await createImageBitmap(blob);
        try {
          aborted(signal);
          result = await repairMiganFrame({ bitmap, selection: region.selection, signal, onProgress });
          blob = result.blob;
        } finally { bitmap.close(); }
      }
    }
    aborted(signal);
    if (findAsset(source.assetId, ["image", "video"]).blob !== sourceBlob) fail("STALE_STATE");
    if (repairClip && [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === request.clipId) !== repairClip) fail("STALE_STATE");
    if (!(result.blob instanceof Blob) || !result.blob.size || !(result.width > 0) || !(result.height > 0)) fail("AI_FAILED");
    const asset = await getEditor().commitAiVisualAsset({ ...result, type: source.type, name: `${source.name} · MI-GAN`,
      sourceDuration: source.duration }, { signal });
    if (!asset?.id) fail("AI_FAILED");
    return { delivery: job.plan.delivery, assetIds: [asset.id], source, regions: request.regions, backend: result.backend,
      ...(request.clipId ? { operations: [{ type: "clip.apply_repair", clipId: request.clipId, assetId: asset.id, regions: request.regions }] } : {}),
      timelineInserted: false };
  };
  const runVisualCutout = async (job, frame, targetClip) => {
    const { signal } = job.controller;
    const { analyzeObjectOutlineImage, analyzeObjectOutlineVideo } = await import("./personOutlineAnalysis.js");
    aborted(signal);
    const video = job.plan.request.output === "video";
    const result = video
      ? await analyzeObjectOutlineVideo({ src: frame.sourceBlob, sourceStart: job.plan.source.sourceTime, duration: job.plan.source.duration, ...job.plan.tracking,
          selectedSubject: job.plan.target, signal, onProgress: ({ progress }) => update(job, "aiSynthesizing", progress * 0.9) })
      : await analyzeObjectOutlineImage({ blob: frame.blob, selectedSubject: job.plan.target, signal,
          onProgress: ({ progress }) => update(job, "aiSynthesizing", progress) });
    aborted(signal);
    if (findAsset(job.plan.source.assetId, ["image", "video"]).blob !== frame.sourceBlob) fail("STALE_STATE");
    if (targetClip && [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])]
      .find(item => item.id === targetClip.id) !== targetClip) fail("STALE_STATE");
    if (video) {
      if (!result.complete || !(result.duration > 0) || result.samples?.length < 2 ||
          !result.samples.every(sample => sample.cutoutBlob instanceof Blob && sample.cutoutBlob.size)) fail("AI_FAILED");
      const { encodePngFrameSequence } = await import("./media.js");
      // The tracker includes an endpoint sample; it is not an extra frame of duration.
      const totalFrames = result.samples.length - 1;
      const blob = await encodePngFrameSequence({ totalFrames, frameRate: totalFrames / result.duration,
        produceFrame: index => result.samples[index].cutoutBlob, transparent: true, audioSourceBlob: frame.sourceBlob,
        audioStart: job.plan.source.sourceTime, audioDuration: result.duration, signal, onProgress: ({ progress }) => update(job, "aiSynthesizing", 90 + progress * 0.1) });
      aborted(signal);
      if (findAsset(job.plan.source.assetId, "video").blob !== frame.sourceBlob) fail("STALE_STATE");
      if (!(blob instanceof Blob) || !blob.size) fail("AI_FAILED");
      const asset = await getEditor().commitAiVisualAsset({ type: "video", blob,
        name: `${job.plan.source.name} · ${job.plan.target.label}`, width: result.sourceSize.width,
        height: result.sourceSize.height, sourceDuration: result.duration }, { signal });
      if (!asset?.id) fail("AI_FAILED");
      return { delivery: job.plan.delivery, assetIds: [asset.id], source: job.plan.source,
        target: job.plan.target, pipeline: result.pipeline, frameRate: totalFrames / result.duration, totalFrames, timelineInserted: false };
    }
    if (!(result.cutoutBlob instanceof Blob) || !result.cutoutBlob.size || !result.complete) fail("AI_FAILED");
    const asset = await getEditor().commitAiVisualAsset({ type: "image", blob: result.cutoutBlob,
      name: `${job.plan.source.name} · ${job.plan.target.label}`, width: result.sourceSize.width, height: result.sourceSize.height,
      sourceDuration: 5 }, { signal });
    if (!asset?.id) fail("AI_FAILED");
    return { delivery: job.plan.delivery, assetIds: [asset.id], source: job.plan.source,
      target: job.plan.target, pipeline: result.pipeline,
      ...(targetClip ? { operations: [{ type: "clip.apply_vision_cutout", clipId: targetClip.id,
        sourceAssetId: job.plan.source.assetId, assetId: asset.id }] } : {}), timelineInserted: false };
  };
  const start = (input, { signal } = {}) => {
    guard(); object(input, ["stateToken", "requestId", "request", "allowModelDownload"]);
    const stateToken = string(input.stateToken);
    const requestId = string(input.requestId);
    if (typeof input.allowModelDownload !== "boolean" || !NO_MODEL_JOB_KINDS.has(input.request?.kind) && input.allowModelDownload !== true) fail("AI_MODEL_DOWNLOAD_REQUIRED");
    object(input.request, Object.keys(WEB_MCP_AI_REQUEST_SCHEMA.oneOf.find((entry) => entry.properties.kind.const === input.request?.kind)?.properties || {}));
    const signature = JSON.stringify({ stateToken, request: Object.entries(input.request).sort(([a], [b]) => a.localeCompare(b)) });
    if (requests.has(requestId)) {
      const previous = requests.get(requestId);
      if (previous.signature !== signature) fail("INVALID_ARGUMENT");
      const job = jobs.get(previous.jobId);
      if (!job) fail("AI_JOB_NOT_FOUND");
      return { ...describe(job), alreadyStarted: true };
    }
    aborted(signal);
    if (active || !acquireProcessing && getEditor().isBusy?.()) fail("EDITOR_BUSY");
    const plan = prepare({ request: input.request });
    const reverseClip = plan.request.kind === "audio_reverse" ? getEditor().audioSegments.find(item => item.id === plan.request.clipId) : null;
    const sourceAudioClip = plan.request.kind === "source_audio_extract"
      ? getEditor()[plan.source.track === "visuals" ? "visualSegments" : "visualOverlaySegments"].find(item => item.id === plan.source.clipId) : null;
    const repairClip = ["visual_repair", "nanovsr", "depth_map", "avatar", "pause_detect", "smart_frame", "caption_avoidance"].includes(plan.request.kind) && plan.request.clipId
      ? [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === plan.request.clipId) : null;
    const cutoutClip = plan.request.kind === "visual_cutout" && plan.source.clipId
      ? [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === plan.source.clipId) : null;
    const separationClip = plan.request.kind === "separation" && plan.request.clipId
      ? getEditor()[{ audio: "audioSegments", music: "musicSegments", visuals: "visualSegments", overlays: "visualOverlaySegments" }[plan.source.track]]?.find(item => item.id === plan.request.clipId) : null;
    const autoCaptionBindings = plan.request.kind === "auto_caption" ? captureAutoCaptionBindings(plan) : null;
    const detectedFrame = plan.request.kind === "visual_cutout" ? plan.request.assetId
      ? { blob: findAsset(plan.request.assetId, plan.request.output === "video" ? "video" : "image").blob,
          sourceBlob: findAsset(plan.request.assetId, plan.request.output === "video" ? "video" : "image").blob }
      : jobs.get(plan.request.detectionJobId).detectedFrame : null;
    const profile = plan.request.cloneVoiceProfileId ? getEditor().voiceProfiles.find(item => item.id === plan.request.cloneVoiceProfileId) : null;
    const referenceRequest = plan.request.kind === "avatar" ? { assetId: plan.request.referenceAssetId } : plan.request.kind === "voice_convert" && !profile
      ? { assetId: plan.request.referenceAssetId, recordingId: plan.request.referenceRecordingId } : null;
    const referenceBlob = referenceRequest ? findVoiceReference(referenceRequest).blob : null;
    if (requests.size >= MAX_REQUESTS) fail("AI_JOB_LIMIT");
    if (jobs.size >= MAX_JOBS) {
      const oldest = [...jobs.values()].find((job) => terminal(job.status));
      if (!oldest) fail("EDITOR_BUSY");
      jobs.delete(oldest.jobId);
    }
    const pauseSource = plan.request.kind === "pause_detect" ? mediaSource(findAsset(plan.request.assetId, "video", { allowUrl: true })) : null;
    const sourceBlob = ["visual_detect", "visual_repair", "nanovsr", "depth_map", "avatar", "smart_frame", "caption_avoidance"].includes(plan.request.kind) ? findAsset(plan.request.assetId, ["image", "video"]).blob
      : plan.request.kind === "source_audio_extract" ? findAsset(plan.request.assetId, "video").blob
      : plan.request.kind === "denoise" ? findAsset(plan.request.assetId, "video").blob
      : plan.request.kind === "separation" ? plan.request.track === "source" ? getEditor().sourceAudioBlob : findAsset(plan.request.assetId, ["audio", "video"]).blob
      : plan.request.kind === "voice_clone_preview" ? findVoiceReference(plan.request).blob
      : ["transcription", "voice_convert"].includes(plan.request.kind) ? findAsset(plan.request.assetId).blob : null;
    const job = {
      jobId: makeId(), requestId, stateToken, plan, controller: new AbortController(),
      status: "queued", progress: null, phaseKey: "aiPreparing", cancelRequested: false,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    };
    jobs.set(job.jobId, job); requests.set(requestId, { signature, jobId: job.jobId }); active = job.jobId;
    const abort = () => {
      if (terminal(job.status)) return;
      job.cancelRequested = true; job.controller.abort(); publish(job);
    };
    signal?.addEventListener("abort", abort, { once: true });
    job.detachSignal = () => signal?.removeEventListener("abort", abort);
    publish(job);
    const dispatch = () => {
      aborted(job.controller.signal);
      if (detectedFrame && findAsset(plan.source.assetId, ["image", "video"]).blob !== detectedFrame.sourceBlob) fail("STALE_STATE");
      if (["visual_detect", "visual_repair", "nanovsr", "depth_map", "avatar", "smart_frame", "caption_avoidance"].includes(plan.request.kind) && findAsset(plan.request.assetId, ["image", "video"]).blob !== sourceBlob) fail("STALE_STATE");
      if (autoCaptionBindings) assertAutoCaptionBindings(autoCaptionBindings);
      if (plan.request.kind === "pause_detect" && mediaSource(findAsset(plan.request.assetId, "video", { allowUrl: true })) !== pauseSource) fail("STALE_STATE");
      if (repairClip && [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === plan.request.clipId) !== repairClip) fail("STALE_STATE");
      if (cutoutClip && [...(getEditor().visualSegments || []), ...(getEditor().visualOverlaySegments || [])].find(item => item.id === plan.source.clipId) !== cutoutClip) fail("STALE_STATE");
      if (reverseClip && getEditor().audioSegments?.find(item => item.id === plan.request.clipId) !== reverseClip) fail("STALE_STATE");
      if (sourceAudioClip && getEditor()[plan.source.track === "visuals" ? "visualSegments" : "visualOverlaySegments"]?.find(item => item.id === plan.source.clipId) !== sourceAudioClip) fail("STALE_STATE");
      if (separationClip && getEditor()[{ audio: "audioSegments", music: "musicSegments", visuals: "visualSegments", overlays: "visualOverlaySegments" }[plan.source.track]]?.find(item => item.id === plan.request.clipId) !== separationClip) fail("STALE_STATE");
      if (profile && getEditor().voiceProfiles?.find(item => item.id === profile.id) !== profile) fail("STALE_STATE");
      if (plan.request.kind === "avatar" && findAsset(plan.request.referenceAssetId).blob !== referenceBlob) fail("STALE_STATE");
      if (plan.request.kind === "voice_clone_preview" && findVoiceReference(plan.request).blob !== sourceBlob) fail("STALE_STATE");
      if (plan.request.kind === "voice_convert") {
        if (findAsset(plan.request.assetId).blob !== sourceBlob) fail("STALE_STATE");
        if (referenceRequest && findVoiceReference(referenceRequest).blob !== referenceBlob) fail("STALE_STATE");
        if (plan.request.track === "source") {
          if (getEditor().sourceAudioLinked !== false || getEditor().sourceAudioBlob !== sourceBlob) fail("STALE_STATE");
        } else if (plan.request.clipId !== undefined && getEditor().audioSegments?.find(item => item.id === plan.request.clipId)?.blob !== sourceBlob) fail("STALE_STATE");
      }
      if (plan.request.kind === "separation" && plan.request.track === "source") {
        const editor = getEditor();
        if (editor.sourceAudioBlob !== sourceBlob || editor.sourceAudioDuration !== plan.request.duration
          || (editor.sourceAudioStart ?? 0) !== plan.request.timelineOffset) fail("STALE_STATE");
      }
      job.status = "running"; job.startedAt = new Date().toISOString(); job.waitReason = "";
      publish(job);
      if (plan.request.kind === "audio_reverse") return runAudioReverse(job, reverseClip);
      if (plan.request.kind === "source_audio_extract") return runSourceAudioExtraction(job, sourceBlob, sourceAudioClip);
      if (plan.request.kind === "smart_frame") return runSmartFrame(job, sourceBlob, repairClip);
      if (plan.request.kind === "caption_avoidance") return runCaptionAvoidance(job, sourceBlob, repairClip);
      if (plan.request.kind === "pause_detect") return runPauseDetection(job, repairClip);
      if (plan.request.kind === "visual_repair") return runVisualRepair(job, sourceBlob, repairClip);
      if (plan.request.kind === "nanovsr") return runNanoVsr(job, sourceBlob, repairClip);
      if (plan.request.kind === "depth_map") return runDepthMap(job, sourceBlob, repairClip);
      if (plan.request.kind === "auto_caption") return runAutoCaption(job, autoCaptionBindings);
      if (plan.request.kind === "avatar") return runAvatar(job, sourceBlob, referenceBlob);
      return plan.request.kind === "visual_cutout" ? runVisualCutout(job, detectedFrame, cutoutClip) : plan.request.kind === "visual_detect" ? runVisualDetection(job, sourceBlob) : plan.request.kind === "voice_convert" ? runVoiceConversion(job, sourceBlob, profile, referenceBlob) : plan.request.kind === "voice_clone_preview" ? runClonePreview(job, sourceBlob) : plan.request.kind === "denoise" ? runDenoise(job, sourceBlob) : plan.request.kind === "separation" ? runSeparation(job, sourceBlob, separationClip) : plan.request.kind === "music" ? runMusic(job) : plan.request.kind === "voiceover" ? runVoiceover(job, profile) : runTranscription(job, sourceBlob);
    };
    const completion = acquireProcessing ? acquireProcessing({ stateToken, signal: job.controller.signal,
      onWaiting: reason => { if (job.waitReason !== reason) { job.waitReason = reason; publish(job); } },
    }).then(release => { job.releaseProcessing = release; return dispatch(); }) : dispatch();
    Promise.resolve(completion).then((result) => {
      // A late cancellation cannot remove an already committed asset batch.
      job.result = result; finish(job, "succeeded");
    }).catch((error) => {
      if (error?.name !== "AbortError" && !job.controller.signal.aborted) console.warn("[WebMCP AI] Local job failed.", error);
      finish(job, error?.name === "AbortError" || job.controller.signal.aborted ? "cancelled" : "failed",
        error?.name === "AbortError" || job.controller.signal.aborted ? undefined : ["EDITOR_BUSY", "STALE_STATE", "AI_UNAVAILABLE"].includes(error?.code) ? error.code : "AI_FAILED");
    });
    return describe(job);
  };
  return {
    capabilities, prepare, start,
    pauseCandidates(input) {
      const job = lookup({ jobId: input.jobId });
      if (job.status !== "succeeded" || job.plan.request.kind !== "pause_detect") fail("AI_JOB_NOT_FOUND");
      if (job.stateToken !== input.stateToken || getEditor().visualSegments?.find(clip => clip.id === job.pauseClip.id) !== job.pauseClip
        || mediaSource(findAsset(job.plan.request.assetId, "video", { allowUrl: true })) !== mediaSource(job.pauseClip)) fail("STALE_STATE");
      return clone(job.result);
    },
    detectionFrame(jobId) {
      guard();
      const job = jobs.get(jobId);
      if (job?.status !== "succeeded" || job.plan.request.kind !== "visual_detect" || !job.detectedFrame) return null;
      const asset = getEditor().assets?.find(item => (item.assetId || item.id) === job.result.assetId);
      return asset?.blob === job.detectedFrame.sourceBlob ? job.detectedFrame.blob : null;
    },
    async saveVoiceProfile(input) {
      guard(); object(input, ["jobId", "name", "auditionApproved"]);
      const name = string(input.name).trim();
      if (input.auditionApproved !== true) fail("INVALID_ARGUMENT");
      const job = lookup({ jobId: input.jobId });
      if (job.status !== "succeeded" || !job.profileDraft) fail("INVALID_ARGUMENT");
      if (!getEditor().voiceLibraryReady) fail("EDITOR_BUSY");
      if (typeof getEditor().addVoiceProfile !== "function") fail("AI_UNAVAILABLE");
      if (job.savedProfile) {
        if (job.savedProfile.name !== name) fail("INVALID_ARGUMENT");
        return { ...job.savedProfile, alreadySaved: true };
      }
      if (job.savingName && job.savingName !== name) fail("INVALID_ARGUMENT");
      if (!job.savingProfile) {
        const now = new Date().toISOString();
        job.profileId ??= makeId();
        job.savingName = name;
        const profile = { ...job.profileDraft, id: job.profileId, name, sourceKind: job.plan.request.recordingId === undefined ? "upload" : "recording", favorite: false,
          authorized: true, embeddingVersion: OPENVOICE_EMBEDDING_VERSION, createdAt: now, updatedAt: now };
        job.savingProfile = Promise.resolve().then(() => { guard(); return getEditor().addVoiceProfile(profile); }).then(() => {
          job.savedProfile = { voiceId: profile.id, name, saved: true };
          getEditor().setSelectedVoiceProfileId?.(profile.id);
          return job.savedProfile;
        }).finally(() => { job.savingProfile = null; job.savingName = null; });
      }
      return job.savingProfile;
    },
    inspect(input) { return describe(lookup(input)); },
    cancel(input) {
      const job = lookup(input);
      if (!terminal(job.status)) { job.cancelRequested = true; job.controller.abort(); publish(job); }
      return describe(job);
    },
    isRunning() { return active !== null && jobs.get(active)?.status === "running"; },
    close() {
      closed = true;
      for (const job of jobs.values()) {
        if (!terminal(job.status)) { job.cancelRequested = true; job.controller.abort(); }
        job.detachSignal?.(); job.detachSignal = null;
      }
    },
  };
}
