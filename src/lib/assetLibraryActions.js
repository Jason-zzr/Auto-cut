import { decodeWaveform } from "./media.js";
import { loadProjectMediaBlob } from "./projectSnapshot.js";

export function inspectAssetReferences(asset, project, library = []) {
  const ids = new Set([asset.id, asset.assetId].filter(Boolean));
  const urls = new Set([asset.src, asset.url].filter(Boolean));
  const matches = value => value && typeof value === "object" && (
    [value.assetId, value.sourceAssetId, value.depthMapSourceAssetId, value.sourceAudioOriginAssetId].some(id => ids.has(id))
    || [value.src, value.url].some(url => urls.has(url)) || asset.blob && value.blob === asset.blob);
  const contains = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== "object" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || seen.has(value)) return false;
    seen.add(value);
    return Boolean(matches(value) || Object.values(value).some(child => contains(child, seen)));
  };
  const references = [];
  for (const [track, key] of Object.entries({ visuals: "visualSegments", overlays: "visualOverlaySegments", audio: "audioSegments", music: "musicSegments", stickers: "stickerSegments" })) {
    for (const clip of project[key] || []) {
      if (contains(clip)) references.push({ track, clipId: clip.id, relation: matches(clip) ? "direct" : "retained-media" });
    }
  }
  for (const [track, key] of [["source", "sourceAudioBlob"], ["music", "musicBlob"], ["audio", "audioBlob"]]) {
    if (asset.blob && project[key] === asset.blob || track === "source" && project.sourceAudioBlob && ids.has(project.sourceAudioAssetId)) {
      references.push({ track, relation: "shared-track-media" });
    }
  }
  for (const item of library) {
    if (item.id !== asset.id && contains(item)) references.push({ track: "library", assetId: item.assetId || item.id, relation: "shared-media" });
  }
  return references;
}

export function createAssetLibraryActions(deps) {
  async function selectAsset(asset, options = {}) {
    if (asset.type === "audio") {
      let blob;
      try { blob = await loadProjectMediaBlob(asset); }
      catch (error) { deps.notify(error.message); return; }
      const hasValidDuration = Number.isFinite(Number(asset.duration)) && Number(asset.duration) > 0;
      const decoded = asset.peaks?.length && hasValidDuration
        ? { duration: Number(asset.duration), peaks: asset.peaks }
        : await decodeWaveform(blob, 96);
      deps.replaceMusic(
        blob,
        decoded.duration,
        decoded.peaks,
        asset.name,
        undefined,
        { focusAudio: options.focusAudio !== false },
      );
      return;
    }
    deps.replaceVisualTimeline(asset, deps.getVisualDurationForAsset(asset));
    deps.notify(`${asset.type === "video" ? "视频" : "图片"}素材已应用到预览和时间线`);
  }

  function deleteUserAsset(asset) {
    deps.removeVisionRecordsForAsset(asset);
    const urlInUse = deps.userAssets.some((item) => item.id !== asset.id && item.src === asset.src);
    if (deps.selectedLibraryAssetId === asset.id) deps.setSelectedLibraryAssetId("");
    deps.setUserAssets((items) => items.filter((item) => item.id !== asset.id));
    if (!urlInUse && deps.imageUrlRefs.current.has(asset.src)) {
      URL.revokeObjectURL(asset.src); deps.imageUrlRefs.current.delete(asset.src);
    }
    if (asset.type === "audio" && asset.blob && asset.blob === deps.musicBlob) {
      deps.clearMusicTrack("背景音乐素材已删除，时间线已同步清空");
      return;
    }
    const isActiveVisual = asset.type !== "audio" && (asset.src === deps.imageSrc ||
      deps.visualSegments.some((segment) => segment.assetId === asset.id || segment.src === asset.src));
    if (!isActiveVisual) return void deps.notify("素材已删除");
    const segments = deps.visualSegments.filter((segment) => segment.assetId !== asset.id && segment.src !== asset.src);
    if (asset.type === "video" && deps.sourceAudioBlob && asset.src === deps.imageSrc) deps.clearSourceAudioTrack(null);
    if (segments.length) deps.commitVisualSegments(segments, "素材已删除，对应视觉片段已移除");
    else deps.clearImageTrack("视觉素材已删除，时间线已同步清空");
  }
  return { deleteUserAsset, selectAsset };
}
