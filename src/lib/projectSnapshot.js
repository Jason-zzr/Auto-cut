import { getDepthAnalysisSignature, getSegmentDepthAnalysis } from "./depthOfField.js";
import { getVisionKey } from "./vision.js";

// Complete-project snapshots retain media separately from editor runtime objects.
const stateFields = [
  "script", "commandState", "selectedVoiceId", "speed", "volume", "captionSegments", "captionPosition",
  "captionPlacement", "captionSize", "captionStyle", "captionStylePresetId", "captionStylePresets", "captionsEnabled",
  "visualSegments", "visualOverlaySegments", "imageName", "imageMeta", "visualType", "imageDuration", "imageClipCount",
  "fitMode", "ratioId", "selectedFilterId", "selectedTransitionId", "stickerSegments", "timelineMarkers", "selectedStickerId",
  "audioSegments", "audioDuration", "timelineHorizon", "musicSegments", "musicStart", "musicName", "musicDuration", "musicVolume",
  "sourceAudioName", "sourceAudioDuration", "sourceAudioVolume", "sourceAudioStart", "sourceAudioAssetId", "sourceAudioLinked",
  "sourceAudioSpatialEffect", "sourceAudioSpatialAmount", "sourceVoiceColorOriginal", "trackVisibility", "trackLocks", "userAssets", "timelineZoom",
  "selectedTrack", "selectedSegmentId", "selectedVisualSegmentId", "selectedVisualOverlayId", "selectedStickerSegmentId",
  "selectedAudioSegmentId", "currentTime",
];
const rootMedia = {
  imageRef: ["imageBlob", "imageSrc"], audioRef: ["audioBlob", "audioUrl"],
  musicRef: ["musicBlob", "musicUrl"], sourceAudioRef: ["sourceAudioBlob", "sourceAudioUrl"],
};
const mediaFields = new Set(["blob", "src", "url", "previewSrc", "originalBlob", "originalSrc", "thumbnail", "compatibilityAudioBlob", "voiceColorOriginalBlob", "voiceColorOriginalUrl", "depthUrl", "cutoutUrl"]);
const cacheFields = new Set(["peaks", "originalPeaks", "voiceColorOriginalPeaks", "trackFrames", "trackFrameSampling", "trackFrameDuration", "trackFrameImportBudget"]);
const referenceKey = (ref) => JSON.stringify([ref.kind, ref.entityId, ref.revision ?? null, ref.blobId ?? null]);
const loadedProjectMedia = new WeakMap();

export function captureProjectState(state) {
  const captured = {};
  for (const key of stateFields) if (state[key] !== undefined) captured[key] = state[key];
  for (const fields of Object.values(rootMedia)) {
    for (const key of fields) if (state[key] !== undefined) captured[key] = state[key];
  }
  for (const field of ["visualSegments", "visualOverlaySegments"]) {
    if (!Array.isArray(captured[field]) || !state.depthRecords) continue;
    captured[field] = captured[field].map((segment) => {
      const { depth: _depth, ...visual } = segment;
      const record = getSegmentDepthAnalysis(segment, state.depthRecords);
      if (!record?.complete || !record.samples?.length || !record.signature) return visual;
      let signature;
      try { signature = JSON.parse(record.signature); } catch { return visual; }
      if (record.signature !== getDepthAnalysisSignature(segment, signature?.quality)) return visual;
      // The saved clip owns the source media binding; runtime URLs cannot be cache identities on reopen.
      return { ...visual, depth: { ...record, signature: getDepthAnalysisSignature({ ...segment, src: "" }, signature.quality) } };
    });
  }
  const copies = new WeakMap();
  const copy = (value) => {
    if (!value || typeof value !== "object" || value instanceof Blob) return value;
    if (copies.has(value)) return copies.get(value);
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return structuredClone(value);
    const result = Array.isArray(value) ? [] : {};
    copies.set(value, result);
    for (const [key, item] of Object.entries(value)) {
      if (!cacheFields.has(key)) result[key] = copy(item);
    }
    return result;
  };
  // Retain immutable Blob identity for reuse across saves, copy mutable metadata.
  return copy(captured);
}

export async function serializeProjectSnapshot(captured, { registerMedia, editorSnapshotId, editorSequence }) {
  const refs = new Map();
  const registrations = new Map();
  const register = async (value, name, path) => {
    if (!(value instanceof Blob) && typeof value !== "string") throw new Error(`无法保存媒体：${path}`);
    const loaded = value instanceof Blob ? loadedProjectMedia.get(value) : null;
    if (loaded) value = projectMediaUrl(loaded.projectId, loaded.ref);
    if (!registrations.has(value)) registrations.set(value, Promise.resolve(registerMedia(value, name, path)));
    const ref = await registrations.get(value);
    if (!ref || ref.kind !== "media" || typeof ref.entityId !== "string" || typeof ref.blobId !== "string") {
      throw new Error(`媒体登记未完成：${path}`);
    }
    refs.set(referenceKey(ref), ref);
    return ref;
  };
  const walk = async (value, path, depth = 0) => {
    if (depth > 64) throw new Error(`项目数据嵌套过深：${path}`);
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      if (typeof value === "string" && (value.startsWith("blob:") || value.startsWith("data:"))) {
        throw new Error(`未识别的媒体字段：${path}`);
      }
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index++) result.push(await walk(value[index], `${path}[${index}]`, depth + 1));
      return result;
    }
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`无法保存运行时对象：${path}`);
    if (value.preparing) throw new Error(`素材尚未准备完成：${value.name || path}`);
    const result = {};
    const bindings = {};
    for (const [field, ref] of Object.entries(value.projectMedia?.bindings || {})) {
      if (ref?.kind !== "media" || !ref.entityId || !ref.blobId) throw new Error(`无效的媒体引用：${path}`);
      if (value[field] == null) bindings[field] = await register(projectMediaUrl(value.projectMedia.projectId, ref), value.name || path, `${path}.${field}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "projectMedia") continue;
      if (cacheFields.has(key) || item === undefined) continue;
      if (key === "bearer" || key === "bootstrapNonce" || key === "mediaBindings") throw new Error(`不允许的项目字段：${path}.${key}`);
      if (mediaFields.has(key)) {
        if (item === null || item === "") continue;
        // A primary Blob and its playback URL identify the same bytes.
        const blobField = key === "voiceColorOriginalUrl" ? "voiceColorOriginalBlob"
          : key === "originalSrc" ? "originalBlob"
            : key === "src" || key === "url" || (key === "previewSrc" && (item === value.src || item === value.url)) ? "blob" : null;
        const source = blobField && value[blobField] instanceof Blob ? value[blobField] : item;
        bindings[key] = await register(source, value.name || path, `${path}.${key}`);
        if (source !== item && typeof item === "string") registrations.set(item, Promise.resolve(bindings[key]));
      } else result[key] = await walk(item, `${path}.${key}`, depth + 1);
    }
    if (Object.keys(bindings).length) result.mediaBindings = bindings;
    return result;
  };
  const payload = {};
  for (const key of stateFields) {
    if (captured[key] !== undefined) payload[key] = await walk(captured[key], key);
  }
  for (const [key, [blobKey, urlKey]] of Object.entries(rootMedia)) {
    const source = captured[blobKey] || captured[urlKey];
    payload[key] = source ? await register(source, captured[`${key.slice(0, -3)}Name`] || key, key) : null;
  }
  return { format: "timeline-studio-editor-snapshot", editorSnapshotId, editorSequence, payload, refs: [...refs.values()] };
}

export async function serializeExecutionBasis(captured, { registerMedia, rippleEditing }) {
  const {
    userAssets: _assets, currentTime: _time, timelineZoom: _zoom, selectedTrack: _track,
    selectedSegmentId: _segment, selectedVisualSegmentId: _visual, selectedVisualOverlayId: _overlay,
    selectedStickerSegmentId: _sticker, selectedAudioSegmentId: _audio, selectedStickerId: _catalogSticker,
    ...content
  } = captured;
  const { payload } = await serializeProjectSnapshot(content, { registerMedia });
  // Restoring a Blob-only clip may add a playback URL for the same registered
  // bytes. Canonicalize that alias, retaining every distinct media reference.
  const canonical = (value, field) => {
    if (Array.isArray(value)) return value.map(item => canonical(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().filter(key => {
      if (field !== "mediaBindings") return true;
      const primary = key === "originalSrc" ? "originalBlob" : key === "voiceColorOriginalUrl" ? "voiceColorOriginalBlob"
        : ["src", "url", "previewSrc"].includes(key) ? "blob" : null;
      return !primary || !value[primary] || referenceKey(value[key]) !== referenceKey(value[primary]);
    }).map(key => [key, canonical(value[key], key)]));
  };
  return { project: canonical(payload), rippleEditing: Boolean(rippleEditing) };
}

export function projectMediaUrl(projectId, ref) {
  if (ref?.kind !== "media" || !ref.entityId || !ref.blobId) throw new Error("无效的项目媒体引用。");
  return `/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(ref.entityId)}/content?blobId=${encodeURIComponent(ref.blobId)}`;
}

export async function loadProjectMediaBlob(item, field = "blob", signal) {
  if (item?.[field] instanceof Blob) return item[field];
  const ref = item?.projectMedia?.bindings?.[field];
  const source = ref ? projectMediaUrl(item.projectMedia.projectId, ref) : field === "blob" ? item?.src || item?.url : null;
  if (!source) throw new Error(`缺少媒体来源：${item?.name || field}`);
  const response = await fetch(source, { credentials: "omit", cache: "no-store", signal });
  if (!response.ok) throw new Error(`无法读取媒体（HTTP ${response.status}）`);
  const blob = await response.blob();
  // Only bytes fetched from a known project binding can reuse its immutable identity.
  if (ref) loadedProjectMedia.set(blob, { projectId: item.projectMedia.projectId, ref: { ...ref } });
  return blob;
}

export async function restoreProjectSnapshot(saved, projectId, { verifyMedia, signal } = {}) {
  if (saved?.format !== "timeline-studio-editor-snapshot" || saved.projectId !== projectId || !saved.payload || !Array.isArray(saved.refs)) {
    throw new Error("无效的完整项目快照。");
  }
  const declared = new Set(saved.refs.map(referenceKey));
  const verified = new Map();
  const media = async (ref) => {
    if (ref?.kind !== "media" || !declared.has(referenceKey(ref))) throw new Error("项目媒体引用不完整。");
    const url = projectMediaUrl(projectId, ref);
    if (!verified.has(url)) {
      verified.set(url, (async () => {
        if (verifyMedia) await verifyMedia(url, ref);
        else {
          const response = await fetch(url, { method: "HEAD", credentials: "omit", cache: "no-store", signal });
          if (!response.ok) throw new Error(`项目媒体不可用（HTTP ${response.status}）`);
        }
      })());
    }
    await verified.get(url);
    return url;
  };
  const walk = async (value, depth = 0) => {
    if (depth > 64) throw new Error("项目数据嵌套过深。");
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) result.push(await walk(item, depth + 1));
      return result;
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key !== "mediaBindings") result[key] = await walk(item, depth + 1);
    }
    if (value.mediaBindings) {
      const bindings = structuredClone(value.mediaBindings);
      for (const [field, ref] of Object.entries(bindings)) {
        if (!mediaFields.has(field)) throw new Error("项目包含不支持的媒体字段。");
        const url = await media(ref);
        result[field] = field.toLowerCase().endsWith("blob") ? null : url;
      }
      result.projectMedia = { projectId, bindings };
      if (bindings.blob && !result.src && !result.url) {
        result[result.type === "audio" ? "url" : "src"] = await media(bindings.blob);
      }
    }
    return result;
  };
  const restored = await walk(saved.payload);
  restored.depthRecords = {};
  for (const field of ["visualSegments", "visualOverlaySegments"]) {
    for (const segment of restored[field] || []) {
      const record = segment.depth;
      if (!record) continue;
      delete segment.depth;
      let signature;
      try { signature = JSON.parse(record.signature); } catch { throw new Error("项目深度分析签名无效。"); }
      if (!record.complete || !Array.isArray(record.samples) || !record.samples.length) throw new Error("项目深度分析未完成。");
      if (record.signature !== getDepthAnalysisSignature({ ...segment, src: "" }, signature?.quality)) continue;
      restored.depthRecords[getVisionKey(segment)] = {
        ...record, signature: getDepthAnalysisSignature(segment, signature.quality),
      };
    }
  }
  const bindings = {};
  for (const [key, [blobKey, urlKey]] of Object.entries(rootMedia)) {
    restored[blobKey] = null;
    restored[urlKey] = saved.payload[key] ? await media(saved.payload[key]) : "";
    if (saved.payload[key]) bindings[blobKey] = saved.payload[key];
    delete restored[key];
  }
  restored.projectMedia = { projectId, bindings };
  return restored;
}
