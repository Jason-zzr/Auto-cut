import { MIN_VISUAL_SEGMENT_SECONDS } from "../config/editor.js";
import { cloneVisualSegment, createVisualSegment, getVisualSegmentTimeline, getVisualSegmentsTotal, isTimedSegmentLaneLocked, makeId, materializeCaptionTimings } from "./timeline.js";
import { normalizeVisualKeyframes, resolveVisualTransform, VISUAL_PROPERTY_KEYS } from "./visualEffects.js";
import { getColorGradeProperty, resolveColorGrade } from "./colorGrade.js";
import { getVisualSpeedCurveAverageRate, getVisualSpeedCurveSourceProgress, getVisualSpeedCurveTimelineProgress, sliceVisualSpeedCurve } from "./visualSpeedCurve.js";

const MIN_CAPTION_SPLIT_SECONDS = 0.2;

export function splitCaptionSegmentState(source, splitTime) {
  return [
    { ...source, id: makeId("caption"), end: splitTime },
    { ...source, id: makeId("caption"), start: splitTime },
  ];
}

export function splitAudioSegmentState(source, time) {
  const firstDuration = time - source.start;
  const secondDuration = source.duration - firstDuration;
  const playbackRate = Math.max(0.25, Math.min(4, Number(source.playbackRate) || 1));
  const peakCount = source.peaks?.length || 0;
  const peakSplit = peakCount > 1 ? Math.max(1, Math.min(peakCount - 1, Math.round(firstDuration / source.duration * peakCount))) : 0;
  return [
    { ...source, duration: firstDuration, sourceDuration: firstDuration * playbackRate,
      peaks: peakCount ? source.peaks.slice(0, peakSplit) : [], fadeOut: 0 },
    { ...source, start: time, duration: secondDuration, sourceDuration: secondDuration * playbackRate,
      sourceStart: Math.max(0, Number(source.sourceStart) || 0) + firstDuration * playbackRate,
      peaks: peakCount ? source.peaks.slice(peakSplit) : [], fadeIn: 0 },
  ];
}

function sliceVisualKeyframes(keyframes, startTime, endTime, baseTransform, colorGrade) {
  const frames = normalizeVisualKeyframes(keyframes);
  if (!frames.length) return frames;
  const boundary = time => {
    const transform = resolveVisualTransform(frames, time, baseTransform);
    const grade = resolveColorGrade(frames, time, colorGrade);
    // A property must stay at its base value until its first original keyframe.
    return Object.fromEntries(VISUAL_PROPERTY_KEYS.filter(key => frames.some(frame =>
      frame.time <= time && Number.isFinite(Number(frame[key])))).map(key =>
      [key, key.startsWith("colorGrade.") ? getColorGradeProperty(grade, key) : transform[key]]));
  };
  return normalizeVisualKeyframes([
    { time: 0, ...boundary(startTime) },
    ...frames.filter(frame => frame.time > startTime && frame.time < endTime)
      .map(frame => ({ ...frame, time: frame.time - startTime })),
    { time: endTime - startTime, ...boundary(endTime) },
  ]);
}

function assertVisualSourceSlice(source) {
  if (source.reversed || source.reverse) throw Object.assign(new Error("Reversed visual timing cannot be sliced"), { code: "UNSUPPORTED_TIMING" });
  if (Object.values(source.propertyKeyframes || {}).some(frames => frames?.length)) {
    throw Object.assign(new Error("Legacy property keyframes cannot be sliced"), { code: "UNSUPPORTED_TIMING" });
  }
}

function visualSlicePatch(source, startTime, endTime) {
  assertVisualSourceSlice(source);
  const duration = Math.max(0, Number(source.duration) || 0);
  const start = Math.max(0, Math.min(duration, Number(startTime) || 0));
  const end = Math.max(start, Math.min(duration, Number(endTime) || 0));
  const patch = { duration: end - start };
  if (Array.isArray(source.keyframes)) patch.keyframes = sliceVisualKeyframes(source.keyframes, start, end, source.baseTransform, source.colorGrade);
  if (source.type !== "video") return patch;
  const sourceStart = Math.max(0, Number(source.sourceStart) || 0);
  const playbackRate = Math.max(0.25, Math.min(4, Number(source.playbackRate) || 1));
  const sourceDuration = Math.max(0, Number(source.sourceDuration) || duration * playbackRate);
  if (source.speedCurve?.enabled) {
    const startProgress = duration ? start / duration : 0;
    const endProgress = duration ? end / duration : 1;
    const sourceIn = getVisualSpeedCurveSourceProgress(source.speedCurve, startProgress);
    const sourceOut = getVisualSpeedCurveSourceProgress(source.speedCurve, endProgress);
    const speedCurve = sliceVisualSpeedCurve(source.speedCurve, startProgress, endProgress);
    return { ...patch, sourceStart: sourceStart + sourceDuration * sourceIn,
      sourceDuration: sourceDuration * (sourceOut - sourceIn), speedCurve,
      playbackRate: getVisualSpeedCurveAverageRate(speedCurve) };
  }
  return { ...patch, sourceStart: sourceStart + start * playbackRate,
    sourceDuration: (end - start) * playbackRate, playbackRate };
}

export function trimVisualSegmentState(source, sourceIn, sourceOut) {
  assertVisualSourceSlice(source);
  const duration = Math.max(0, Number(source.duration) || 0);
  const retainedStart = Math.max(0, Number(source.sourceStart) || 0);
  const retainedDuration = Math.max(0, Number(source.sourceDuration) || duration * Math.max(0.25, Math.min(4, Number(source.playbackRate) || 1)));
  const from = Number(sourceIn), to = Number(sourceOut);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || from < retainedStart || to > retainedStart + retainedDuration) {
    throw Object.assign(new Error("Trim range exceeds the retained visual source"), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const sourceStartProgress = retainedDuration ? (from - retainedStart) / retainedDuration : 0;
  const sourceEndProgress = retainedDuration ? (to - retainedStart) / retainedDuration : 1;
  const rate = Math.max(0.25, Math.min(4, Number(source.playbackRate) || 1));
  const startTime = source.speedCurve?.enabled
    ? getVisualSpeedCurveTimelineProgress(source.speedCurve, sourceStartProgress) * duration
    : (from - retainedStart) / rate;
  const endTime = source.speedCurve?.enabled
    ? getVisualSpeedCurveTimelineProgress(source.speedCurve, sourceEndProgress) * duration
    : (to - retainedStart) / rate;
  return cloneVisualSegment(source, { ...visualSlicePatch(source, startTime, endTime), sourceStart: from, sourceDuration: to - from });
}

export function resizeVisualSegmentState(source, duration) {
  assertVisualSourceSlice(source);
  const currentDuration = Math.max(0, Number(source.duration) || 0);
  const nextDuration = Number(duration);
  if (!Number.isFinite(nextDuration) || nextDuration <= 0 || nextDuration > currentDuration + 0.000001) {
    throw Object.assign(new Error("Resize exceeds the retained visual source"), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  return cloneVisualSegment(source, visualSlicePatch(source, 0, nextDuration));
}

export function splitOverlaySegmentState(source, time) {
  const duration = Math.max(0, Number(source.duration) || 0);
  const firstDuration = time - Math.max(0, Number(source.start) || 0);
  return [
    cloneVisualSegment(source, {
      id: source.id, ...visualSlicePatch(source, 0, firstDuration),
    }),
    cloneVisualSegment(source, {
      id: source.id, start: time, ...visualSlicePatch(source, firstDuration, duration),
    }),
  ];
}

export function splitVisualSegmentState(source, firstDuration, secondDuration) {
  const duration = firstDuration + secondDuration;
  return [
    cloneVisualSegment(source, {
      id: makeId("visual"),
      ...visualSlicePatch(source, 0, firstDuration),
    }),
    cloneVisualSegment(source, {
      id: makeId("visual"),
      ...visualSlicePatch(source, firstDuration, duration),
    }),
  ];
}

export function createTimelineCutActions(d) {
  const handleCutVisualSegment = () => {
    if (d.trackLocks.image) return void d.notify("图片轨已锁定，无法剪切");
    if (!d.imageSrc) return void d.notify("请先上传或选择图片/视频素材");
    const segments = d.visualSegments.length ? d.visualSegments : [createVisualSegment(d.imageDuration || 0, d.getCurrentVisualAssetSnapshot())];
    const duration = getVisualSegmentsTotal(segments);
    if (duration < MIN_VISUAL_SEGMENT_SECONDS * 2) return void d.notify("当前视觉片段太短，不适合继续剪切");
    const time = Math.max(0, Math.min(duration, d.currentTime));
    if (time < MIN_VISUAL_SEGMENT_SECONDS || time > duration - MIN_VISUAL_SEGMENT_SECONDS) return void d.notify("请把播放头放在视觉片段中间再剪切");
    const timeline = getVisualSegmentTimeline(segments);
    const index = timeline.findIndex((range) => time > range.start && time < range.end);
    const range = timeline[index]; const source = segments[index];
    if (!source || !range) return void d.notify("请先选中要剪切的视觉片段");
    if (source.reversed || source.reverse || Object.values(source.propertyKeyframes || {}).some((frames) => frames?.length)) return void d.notify("当前片段的复杂时序暂不支持剪切");
    const firstDuration = time - range.start; const secondDuration = range.end - time;
    if (firstDuration < MIN_VISUAL_SEGMENT_SECONDS || secondDuration < MIN_VISUAL_SEGMENT_SECONDS) return void d.notify("切点离片段边缘太近，先把播放头移到片段中间");
    const [first, second] = splitVisualSegmentState(source, firstDuration, secondDuration);
    const next = [...segments]; next.splice(index, 1, first, second);
    d.commitVisualSegments(next, "已在播放头位置切开视觉片段", index + 1);
  };
  const handleCutCaption = () => {
    if (d.trackLocks.caption) return void d.notify("字幕轨已锁定，无法剪切");
    const index = d.selectedSegmentId ? d.selectedSegmentIndex : d.focusedSegmentIndex;
    const timedSegments = materializeCaptionTimings(d.captionSegments, d.captionTargetDuration);
    const source = timedSegments[index];
    if (!source) return void d.notify("请先选择一个字幕片段");
    const splitTime = Math.max(source.start, Math.min(source.end, d.currentTime));
    if (
      splitTime <= source.start + MIN_CAPTION_SPLIT_SECONDS
      || splitTime >= source.end - MIN_CAPTION_SPLIT_SECONDS
    ) {
      return void d.notify("请把播放头放在字幕片段中间再剪切");
    }
    const next = [...timedSegments];
    next.splice(index, 1, ...splitCaptionSegmentState(source, splitTime));
    d.commitCaptionSegments(next, "已在播放头位置切开字幕片段", index + 1);
  };
  const handleCutAudioSegment = () => {
    const index = d.audioSegments.findIndex((segment) => segment.id === d.selectedAudioSegmentId);
    const source = d.audioSegments[index];
    if (!source) return void d.notify("请先选择一个配音片段");
    if (isTimedSegmentLaneLocked(d.audioSegments, source.id, d.trackLocks)) return void d.notify("配音轨已锁定，无法剪切");
    const time = Math.max(source.start, Math.min(source.start + source.duration, d.currentTime));
    if (time <= source.start + 0.05 || time >= source.start + source.duration - 0.05) {
      return void d.notify("请把播放头放在配音片段中间再剪切");
    }
    const firstDuration = time - source.start;
    const secondDuration = source.duration - firstDuration;
    const playbackRate = Math.max(0.25, Math.min(4, Number(source.playbackRate) || 1));
    const peakSplit = Math.max(1, Math.min((source.peaks?.length || 1) - 1, Math.round((firstDuration / source.duration) * (source.peaks?.length || 0))));
    const firstId = makeId("voice");
    const secondId = makeId("voice");
    const firstUrl = source.blob ? URL.createObjectURL(source.blob) : source.url;
    const secondUrl = source.blob ? URL.createObjectURL(source.blob) : source.url;
    const first = {
      ...source,
      id: firstId,
      url: firstUrl,
      duration: firstDuration,
      sourceDuration: firstDuration * playbackRate,
      peaks: source.peaks?.slice(0, peakSplit) || [],
      fadeOut: 0,
    };
    const second = {
      ...source,
      id: secondId,
      url: secondUrl,
      start: time,
      duration: secondDuration,
      sourceDuration: secondDuration * playbackRate,
      sourceStart: Math.max(0, Number(source.sourceStart) || 0) + firstDuration * playbackRate,
      peaks: source.peaks?.slice(peakSplit) || [],
      fadeIn: 0,
    };
    d.setAudioSegments((segments) => {
      const next = [...segments];
      next.splice(index, 1, first, second);
      return next;
    });
    if (source.blob && source.url) URL.revokeObjectURL(source.url);
    d.setCaptionSegments((captions) => captions.map((caption) => caption.audioSegmentId === source.id
      ? { ...caption, audioSegmentId: firstId, end: Math.min(caption.end, time) }
      : caption));
    d.setSelectedAudioSegmentId(secondId);
    d.notify("已在播放头位置切开配音片段");
  };
  const handleCutMusicSegment = () => {
    if (d.trackLocks.music) return void d.notify("音乐轨已锁定，无法剪切");
    if (!d.musicBlob || d.musicDuration <= 0) return void d.notify("请先添加背景音乐");
    const segments = d.musicSegments?.length ? d.musicSegments : [{
      id: "music-audio", start: d.musicStart || 0, duration: d.musicDuration,
      sourceStart: 0, peaks: d.musicPeaks || [],
    }];
    const index = segments.findIndex((segment) => (
      (!d.selectedMusicSegmentId || segment.id === d.selectedMusicSegmentId)
      && d.currentTime > segment.start + 0.05
      && d.currentTime < segment.start + segment.duration - 0.05
    ));
    const source = segments[index];
    if (!source) return void d.notify("请把播放头放在音乐片段中间再剪切");
    const [first, second] = splitAudioSegmentState(source, d.currentTime);
    first.id = makeId("music");
    second.id = makeId("music");
    const next = [...segments];
    next.splice(index, 1, first, second);
    d.setMusicSegments(next);
    d.setSelectedMusicSegmentId?.(second.id);
    d.notify("已在播放头位置切开音乐片段");
  };
  const handleCutOverlaySegment = () => {
    if (d.trackLocks.overlay) return void d.notify(d.t("effectClipLocked"));
    const index = d.visualOverlaySegments.findIndex((segment) => segment.id === d.selectedVisualOverlayId);
    const source = d.visualOverlaySegments[index];
    if (!source) return void d.notify("请先选择一个画中画片段");
    if (source.reversed || source.reverse || Object.values(source.propertyKeyframes || {}).some((frames) => frames?.length)) return void d.notify("当前片段的复杂时序暂不支持剪切");
    const start = Math.max(0, Number(source.start) || 0);
    const duration = Math.max(0, Number(source.duration) || 0);
    const time = Math.max(start, Math.min(start + duration, d.currentTime));
    const firstDuration = time - start;
    const secondDuration = duration - firstDuration;
    if (firstDuration < MIN_VISUAL_SEGMENT_SECONDS || secondDuration < MIN_VISUAL_SEGMENT_SECONDS) {
      return void d.notify("切点离片段边缘太近，先把播放头移到片段中间");
    }
    const [first, second] = splitOverlaySegmentState(source, time);
    first.id = makeId("overlay");
    second.id = makeId("overlay");
    const next = [...d.visualOverlaySegments];
    next.splice(index, 1, first, second);
    d.setVisualOverlaySegments(next);
    d.setSelectedVisualOverlayId(second.id);
    d.notify("已在播放头位置切开视觉片段");
  };
  const handleCutTrack = () => {
    if (d.selectedTrack === "image") return void handleCutVisualSegment();
    if (d.selectedTrack === "overlay" && d.selectedVisualOverlayId) return void handleCutOverlaySegment();
    if (d.selectedTrack === "caption" && d.selectedSegmentId) return void handleCutCaption();
    if (d.selectedTrack === "audio" && d.selectedAudioSegmentId) return void handleCutAudioSegment();
    if (d.selectedTrack === "music" && d.selectedMusicSegmentId) return void handleCutMusicSegment();
    if (d.selectedTrack === "sticker" && d.selectedStickerSegmentId) {
      if (d.trackLocks.sticker) return void d.notify("贴纸轨已锁定，无法剪切");
      const selected = d.selectedStickerSegmentId && d.stickerSegments.findIndex((segment) => segment.id === d.selectedStickerSegmentId);
      const index = selected >= 0 ? selected : d.currentStickerSegmentIndex >= 0 ? d.currentStickerSegmentIndex : 0;
      const source = d.stickerSegments[index]; if (!source) return void d.notify("请先选择一个贴纸片段");
      const time = Math.max(source.start, Math.min(source.start + source.duration, d.currentTime));
      if (time <= source.start + 0.35 || time >= source.start + source.duration - 0.35) return void d.notify("请把播放头放在贴纸片段中间再剪切");
      const first = { ...source, id: makeId("sticker"), duration: time - source.start };
      const second = { ...source, id: makeId("sticker"), start: time, duration: source.start + source.duration - time };
      const next = [...d.stickerSegments]; next.splice(index, 1, first, second);
      return void d.commitStickerSegments(next, "已在播放头位置切开贴纸片段", second.id);
    }
    // The toolbar split action should remain useful even after the user clicks a
    // track background (which clears clip selection). In that state, treat the
    // primary visual under the playhead as the default editing target.
    return void handleCutVisualSegment();
  };
  return { handleCutTrack };
}
