import {
  DEFAULT_EXPORT_SETTINGS,
  getExportEstimate,
  getExportRange,
  getExportTechnicalSummary,
  normalizeExportSettings,
  sanitizeExportFileName,
} from "./exportSettings.js";
import { getLinkedSourceAudioSegments } from "./sourceAudioSync.js";
import { getVisualSegmentTimeline } from "./timeline.js";

const MAX_JOBS = 64;
const MAX_REQUESTS = 1024;
const terminal = (status) => ["succeeded", "failed", "cancelled"].includes(status);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const object = (value, allowed) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) fail("INVALID_ARGUMENT");
};
const identifier = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 256) fail("INVALID_ARGUMENT");
  return value;
};
const clone = (value) => JSON.parse(JSON.stringify(value));

export const WEB_MCP_EXPORT_SETTINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    clipId: { type: "string", minLength: 1, maxLength: 256, description: "For video, a main-visual or overlay clip ID selects its timeline interval and exports the full composition there, including other visible tracks, captions and mix; it does not isolate the source asset. Explicit range bounds must match that interval. For audio, an audio/music clip ID, linked source clip's visual ID, or source-audio for an unlinked source track." },
    mediaType: { type: "string", enum: ["video", "audio"] },
    audioFormat: { type: "string", enum: ["wav", "mp3"] },
    resolution: { type: "string", enum: ["720", "1080", "1440", "2160"] },
    frameRate: { type: "number", enum: [24, 30, 60] },
    codec: { type: "string", enum: ["h264", "h264-mov", "vp9", "vp8"] },
    quality: { type: "string", enum: ["standard", "high", "ultra"] },
    pipeline: { type: "string", enum: ["auto", "deterministic", "compatible"] },
    audio: { type: "string", enum: ["mix", "none"] },
    audioBitsPerSecond: { type: "number", enum: [128_000, 192_000, 256_000, 320_000] },
    captions: { type: "string", enum: ["burned", "none", "burned-srt"] },
    fileName: { type: "string", minLength: 1, maxLength: 96 },
    range: { type: "string", enum: ["full", "custom"] },
    rangeStart: { type: "number", minimum: 0 },
    rangeEnd: { type: "number", minimum: 0 },
    bitrateMode: { type: "string", enum: ["auto", "custom"] },
    customVideoBitsPerSecond: { type: "number", minimum: 1_000_000, maximum: 100_000_000 },
    keyFrameInterval: { type: "number", enum: [1, 2, 5] },
  },
};

/** Reject invalid agent input before the UI's forgiving preference normalization. */
export function validateWebMcpExportSettings(input = {}, defaults = DEFAULT_EXPORT_SETTINGS) {
  const fields = WEB_MCP_EXPORT_SETTINGS_SCHEMA.properties;
  object(input, Object.keys(fields));
  for (const [key, value] of Object.entries(input)) {
    const field = fields[key];
    if (typeof value !== field.type || (field.type === "number" && !Number.isFinite(value))) fail("INVALID_ARGUMENT");
    if (field.enum && !field.enum.includes(value)) fail("INVALID_ARGUMENT");
    if (field.minimum !== undefined && value < field.minimum) fail("INVALID_ARGUMENT");
    if (field.maximum !== undefined && value > field.maximum) fail("INVALID_ARGUMENT");
    if (key === "fileName" && (value.length > 96 || !value.trim()
      || sanitizeExportFileName(value) !== value)) fail("INVALID_ARGUMENT");
  }
  const settings = normalizeExportSettings({ ...normalizeExportSettings(defaults), mediaType: "video", ...input });
  if (input.clipId !== undefined) {
    identifier(input.clipId);
    settings.clipId = input.clipId;
  }
  // Match the original audio exporter so the review describes the actual output.
  if (settings.mediaType === "audio") {
    if (input.range === "custom" || input.audio === "none"
      || (input.captions !== undefined && input.captions !== "none")) fail("INVALID_ARGUMENT");
    settings.range = "full";
    settings.audio = "mix";
    settings.captions = "none";
    return settings;
  }
  // The real exporter forces MOV through WebCodecs; make that visible in the plan.
  if (settings.codec === "h264-mov") {
    if (input.pipeline === "compatible") fail("INVALID_ARGUMENT");
    settings.pipeline = "deterministic";
  }
  return settings;
}

/**
 * Page-scoped export receipts. The host validates the reviewed project state before
 * start. The shared UI action owns encoding, downloads and its AbortController.
 */
export function createWebMcpExportJobs(getEditor, { makeId = () => crypto.randomUUID(), acquireProcessing } = {}) {
  const jobs = new Map();
  // Keep small tombstones after receipt eviction so a retry never downloads twice.
  const requests = new Map();
  let active = null;
  let closed = false;
  const guard = () => { if (closed) fail("SESSION_CLOSED"); };
  const resolveVideoClip = (editor, clipId) => {
    const visuals = editor.visualSegments || [], overlays = editor.visualOverlaySegments || [];
    const matches = [...visuals, ...overlays].filter(clip => clip.id === clipId);
    if (matches.length !== 1) fail("INVALID_ARGUMENT");
    const clip = matches[0], main = visuals.includes(clip);
    const start = main ? getVisualSegmentTimeline(visuals).find(item => item.id === clipId).start : clip.start;
    if (!["image", "video"].includes(clip.type) || clip.preparing || clip.reversing
      || !Number.isFinite(start) || start < 0 || !Number.isFinite(clip.duration) || clip.duration <= 0) fail("INVALID_ARGUMENT");
    return { clip, track: main ? "visuals" : "overlays", start, end: start + clip.duration };
  };
  const resolveAudioClip = (editor, clipId) => {
    const audio = (editor.audioSegments || []).find(clip => clip.id === clipId);
    const runtime = editor.getRuntimeProject?.() || editor;
    const music = (editor.musicSegments || []).find(clip => clip.id === clipId)
      || (!(editor.musicSegments || []).length && clipId === "music-audio"
        ? { id: clipId, name: runtime.musicName, start: runtime.musicStart ?? 0, duration: runtime.musicDuration, sourceStart: 0, sourceDuration: runtime.musicDuration } : null);
    const source = runtime.sourceAudioLinked !== false
      ? getLinkedSourceAudioSegments(runtime.visualSegments || editor.visualSegments, runtime.sourceAudioAssetId, runtime.sourceAudioDuration).find(clip => clip.id === clipId)
      : clipId === "source-audio" ? { id: clipId, start: runtime.sourceAudioStart, duration: runtime.sourceAudioDuration, sourceStart: 0 } : null;
    const clip = audio || music || source;
    const blob = clip?.blob || (audio ? editor.audioBlob : music ? editor.musicBlob : runtime.sourceAudioBlob);
    if (!clip || !(blob instanceof Blob) || !blob.size || clip.reversing || !(clip.duration > 0)) fail("INVALID_ARGUMENT");
    return { ...clip, blob, volume: clip.volume ?? (audio ? runtime.volume : music ? runtime.musicVolume : runtime.sourceAudioVolume) ?? 1,
      ...(!audio && !music ? { name: runtime.sourceAudioName, spatialEffect: runtime.sourceAudioSpatialEffect, spatialAmount: runtime.sourceAudioSpatialAmount } : {}) };
  };
  const describe = (job) => clone({
    jobId: job.jobId,
    requestId: job.requestId,
    stateToken: job.stateToken,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    phaseKey: job.phaseKey,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...job.plan,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
  const prepare = (input = {}) => {
    guard();
    object(input, ["settings"]);
    const editor = getEditor();
    const resolvedSettings = validateWebMcpExportSettings(input.settings, editor.exportSettings);
    const videoTarget = resolvedSettings.clipId && resolvedSettings.mediaType === "video" ? resolveVideoClip(editor, resolvedSettings.clipId) : null;
    const clip = resolvedSettings.clipId && resolvedSettings.mediaType === "audio" ? resolveAudioClip(editor, resolvedSettings.clipId) : null;
    const duration = clip?.duration ?? editor.exportContentDuration ?? editor.duration;
    const { ratio } = editor;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) fail("EMPTY_PROJECT");
    if (!ratio || !Number.isFinite(ratio.width) || !Number.isFinite(ratio.height)
      || ratio.width <= 0 || ratio.height <= 0) fail("INVALID_ARGUMENT");
    if (videoTarget) {
      for (const [field, expected] of [["rangeStart", videoTarget.start], ["rangeEnd", videoTarget.end]]) {
        if (input.settings?.[field] !== undefined && Math.abs(input.settings[field] - expected) > 1e-9) fail("INVALID_ARGUMENT");
      }
      resolvedSettings.range = "custom";
      resolvedSettings.rangeStart = videoTarget.start;
      resolvedSettings.rangeEnd = videoTarget.end;
    }
    if (resolvedSettings.range === "custom" && (resolvedSettings.rangeEnd > duration
      || resolvedSettings.rangeStart >= resolvedSettings.rangeEnd)) fail("INVALID_ARGUMENT");
    const range = getExportRange(resolvedSettings, duration);
    if (range.duration < 1 / Math.max(24, resolvedSettings.frameRate)) fail("INVALID_ARGUMENT");
    return {
      resolvedSettings,
      ...(clip ? { target: { clipId: clip.id, name: String(clip.name || ""), duration: clip.duration } } : {}),
      ...(videoTarget ? { target: { clipId: videoTarget.clip.id, track: videoTarget.track, name: String(videoTarget.clip.name || ""),
        duration: videoTarget.clip.duration, start: videoTarget.start, end: videoTarget.end, composition: "full-timeline-interval" } } : {}),
      range,
      technical: resolvedSettings.mediaType === "audio" ? {
        container: resolvedSettings.audioFormat.toUpperCase(),
        video: null,
        audio: resolvedSettings.audioFormat === "mp3" ? "MP3" : "PCM 16-bit",
        sampleRate: 48_000,
        channels: 2,
        audioBitrateKbps: resolvedSettings.audioFormat === "mp3" ? resolvedSettings.audioBitsPerSecond / 1000 : 1536,
      } : getExportTechnicalSummary(resolvedSettings, ratio),
      estimate: getExportEstimate(resolvedSettings, ratio, duration),
      delivery: "browser-download",
    };
  };
  const lookup = (input) => {
    guard();
    object(input, ["jobId"]);
    const job = jobs.get(identifier(input.jobId));
    if (!job) fail("EXPORT_JOB_NOT_FOUND");
    return job;
  };
  const finish = (job, status, error) => {
    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (error) job.error = { code: error };
    job.detachSignal?.();
    job.detachSignal = null;
    job.releaseProcessing?.(); job.releaseProcessing = null;
    if (active === job.jobId) active = null;
  };
  const start = (input, { signal } = {}) => {
    guard();
    object(input, ["stateToken", "settings", "requestId"]);
    const stateToken = identifier(input.stateToken);
    const requestId = input.requestId === undefined ? makeId() : identifier(input.requestId);
    // Compare the caller's supplied settings, independent of changed UI defaults.
    object(input.settings ?? {}, Object.keys(WEB_MCP_EXPORT_SETTINGS_SCHEMA.properties));
    const signature = JSON.stringify({ stateToken, settings: Object.entries(input.settings ?? {}).sort(([a], [b]) => a.localeCompare(b)) });
    if (requests.has(requestId)) {
      const previous = requests.get(requestId);
      if (previous.signature !== signature) fail("INVALID_ARGUMENT");
      const job = jobs.get(previous.jobId);
      if (!job) fail("EXPORT_JOB_NOT_FOUND");
      return { ...describe(job), alreadyStarted: true };
    }
    if (signal?.aborted) fail("CANCELLED");
    const editor = getEditor();
    if (active || !acquireProcessing && (editor.exporting || editor.isBusy?.())) fail("EDITOR_BUSY");
    const plan = prepare({ settings: input.settings });
    const clip = plan.resolvedSettings.clipId && plan.resolvedSettings.mediaType === "audio" ? resolveAudioClip(editor, plan.resolvedSettings.clipId) : null;
    const videoTarget = plan.resolvedSettings.clipId && plan.resolvedSettings.mediaType === "video" ? resolveVideoClip(editor, plan.resolvedSettings.clipId) : null;
    if (typeof (clip ? editor.download : editor.exportVideo) !== "function") fail("SESSION_CLOSED");
    if (requests.size >= MAX_REQUESTS) fail("EXPORT_JOB_LIMIT");
    if (jobs.size >= MAX_JOBS) {
      const oldest = [...jobs.values()].find((job) => terminal(job.status));
      if (!oldest) fail("EDITOR_BUSY");
      jobs.delete(oldest.jobId);
    }
    const controller = new AbortController();
    const job = {
      jobId: makeId(), requestId, stateToken, plan, controller,
      status: "queued", progress: 0, phase: "", phaseKey: "",
      cancelRequested: false,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    };
    jobs.set(job.jobId, job);
    requests.set(requestId, { jobId: job.jobId, signature });
    active = job.jobId;
    const abort = () => {
      if (terminal(job.status)) return;
      job.cancelRequested = true;
      controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    job.detachSignal = () => signal?.removeEventListener("abort", abort);
    const dispatch = () => {
      if (controller.signal.aborted) throw Object.assign(new Error("CANCELLED"), { name: "AbortError" });
      if (videoTarget) {
        let current;
        try { current = resolveVideoClip(getEditor(), videoTarget.clip.id); } catch { fail("STALE_STATE"); }
        if (current.clip !== videoTarget.clip || current.start !== videoTarget.start || current.end !== videoTarget.end) fail("STALE_STATE");
      }
      job.status = "running";
      job.phase = "";
      job.startedAt = new Date().toISOString();
      const options = {
        settings: clone(plan.resolvedSettings),
        signal: controller.signal,
        onProgress: (update = {}) => {
          if (terminal(job.status)) return;
          if (Number.isFinite(update.progress)) job.progress = Math.max(job.progress, Math.min(100, Math.max(0, Math.round(update.progress))));
          if (typeof update.phase === "string") job.phase = update.phase;
          if (typeof update.phaseKey === "string") job.phaseKey = update.phaseKey;
        },
      };
      if (!clip) return getEditor().exportVideo(options);
      return import("./audioExport.js").then(async ({ exportAudioClip }) => {
        const result = await exportAudioClip({ segment: clip, format: plan.resolvedSettings.audioFormat,
          audioBitsPerSecond: plan.resolvedSettings.audioBitsPerSecond, signal: controller.signal, onProgress: options.onProgress });
        if (controller.signal.aborted) throw Object.assign(new Error("CANCELLED"), { name: "AbortError" });
        getEditor().download(result.blob, `${plan.resolvedSettings.fileName}.${result.extension}`);
        return { status: "success", extension: result.extension, byteSize: result.blob.size, actualPipeline: "offline-audio" };
      });
    };
    let completion;
    try {
      completion = acquireProcessing ? acquireProcessing({ stateToken, signal: controller.signal,
        onWaiting: reason => { job.phase = reason; },
      }).then(release => { job.releaseProcessing = release; return dispatch(); }) : dispatch();
    } catch (error) {
      finish(job, error?.name === "AbortError" ? "cancelled" : "failed", error?.name === "AbortError" ? undefined : error?.code === "STALE_STATE" ? "STALE_STATE" : "EXPORT_FAILED");
      return describe(job);
    }
    Promise.resolve(completion).then((result) => {
      if (result?.status === "success") {
        const audioOnly = plan.resolvedSettings.mediaType === "audio";
        const expectedExtension = audioOnly ? plan.resolvedSettings.audioFormat
          : ({ h264: "mp4", "h264-mov": "mov", vp9: "webm", vp8: "webm" }[plan.resolvedSettings.codec]);
        if (!(audioOnly ? [expectedExtension] : ["mp4", "webm", "mov"]).includes(result.extension)
          || !Number.isFinite(result.byteSize) || result.byteSize < 12
          || !(audioOnly ? ["offline-audio"] : ["compatible", "deterministic"]).includes(result.actualPipeline)) {
          finish(job, "failed", "EXPORT_FAILED");
          return;
        }
        job.progress = 100;
        job.result = {
          extension: result.extension,
          byteSize: result.byteSize,
          actualPipeline: result.actualPipeline,
          fileName: `${plan.resolvedSettings.fileName}.${result.extension}`,
          delivery: "browser-download",
          // The browser controls whether a triggered download is saved to disk.
          downloadTriggered: true,
          formatFallback: result.extension !== expectedExtension,
          sidecars: !audioOnly && Array.isArray(result.sidecars) ? result.sidecars.filter((item) => item.extension === "srt" && Number.isFinite(item.byteSize) && item.byteSize > 0)
            .map((item) => ({ fileName: `${plan.resolvedSettings.fileName}.srt`, extension: "srt", byteSize: item.byteSize })) : [],
        };
        // A late cancellation cannot undo an already-triggered browser download.
        finish(job, "succeeded");
      } else if (["canceled", "cancelled"].includes(result?.status)) {
        finish(job, "cancelled");
      } else {
        finish(job, "failed", result?.status === "busy" ? "EDITOR_BUSY" : result?.status === "blocked" ? "EMPTY_PROJECT" : "EXPORT_FAILED");
      }
    }).catch((error) => {
      finish(job, error?.name === "AbortError" ? "cancelled" : "failed", error?.name === "AbortError" ? undefined : error?.code === "STALE_STATE" ? "STALE_STATE" : "EXPORT_FAILED");
    });
    return describe(job);
  };
  return {
    prepare,
    start,
    isRunning() { return active !== null && jobs.get(active)?.status === "running"; },
    inspect(input) { return describe(lookup(input)); },
    cancel(input) {
      const job = lookup(input);
      if (!terminal(job.status)) {
        job.cancelRequested = true;
        job.controller.abort();
      }
      return describe(job);
    },
    close() {
      closed = true;
      for (const job of jobs.values()) {
        if (!terminal(job.status)) { job.cancelRequested = true; job.controller.abort(); }
        job.detachSignal?.();
        job.detachSignal = null;
      }
    },
  };
}
