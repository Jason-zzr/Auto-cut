import { MAX_TIMELINE_DURATION_SECONDS, MIN_VISUAL_SEGMENT_SECONDS } from "../config/editor.js";
import { MAX_VISUAL_PLAYBACK_RATE, MIN_VISUAL_PLAYBACK_RATE, normalizeVisualKeyframes } from "./visualEffects.js";

export const DEFAULT_VISUAL_SPEED_CURVE_POINTS = Object.freeze([
  { id: "speed-0", progress: 0, rate: 1 },
  { id: "speed-1", progress: 0.18, rate: 1 },
  { id: "speed-2", progress: 0.48, rate: 1 },
  { id: "speed-3", progress: 0.72, rate: 1 },
  { id: "speed-4", progress: 1, rate: 1 },
]);

export const VISUAL_SPEED_STAGE_KEYS = Object.freeze([
  "visualSpeedStageStart",
  "visualSpeedStagePush",
  "visualSpeedStageClimax",
  "visualSpeedStageClose",
]);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function normalizeVisualSpeedCurve(value) {
  const source = Array.isArray(value?.points) && value.points.length >= 2
    ? value.points
    : DEFAULT_VISUAL_SPEED_CURVE_POINTS;
  const points = source
    .filter((point) => point && Number.isFinite(Number(point.progress)) && Number.isFinite(Number(point.rate)))
    .map((point, index) => ({
      id: String(point.id || `speed-${index}`),
      progress: clamp(Number(point.progress), 0, 1),
      rate: clamp(Number(point.rate), MIN_VISUAL_PLAYBACK_RATE, MAX_VISUAL_PLAYBACK_RATE),
      ...(Array.isArray(point.easingRange) && point.easingRange.length === 2
        && point.easingRange.every(Number.isFinite) && point.easingRange[0] >= 0
        && point.easingRange[1] <= 1 && point.easingRange[1] > point.easingRange[0]
        ? { easingRange: [...point.easingRange] } : {}),
    }))
    .sort((left, right) => left.progress - right.progress)
    .reduce((result, point) => {
      const previous = result.at(-1);
      if (previous && Math.abs(previous.progress - point.progress) < 1e-12) result[result.length - 1] = point;
      else result.push(point);
      return result;
    }, []);
  const safePoints = points.length >= 2 ? points : DEFAULT_VISUAL_SPEED_CURVE_POINTS.map((point) => ({ ...point }));
  safePoints[0] = { ...safePoints[0], progress: 0 };
  safePoints[safePoints.length - 1] = { ...safePoints.at(-1), progress: 1 };
  return {
    enabled: value?.enabled === true,
    smooth: value?.smooth !== false,
    points: safePoints,
  };
}

function easingCoefficients([start, end] = [0, 1]) {
  const width = end - start;
  // Smoothstep restricted to this interval, normalized to its endpoint values.
  return [6 * start * (1 - start), 3 * (1 - 2 * start) * width, -2 * width * width];
}

function easingValue(progress, smooth, range) {
  const t = clamp(progress, 0, 1);
  if (!smooth) return t;
  const [a, b, c] = easingCoefficients(range);
  return (a * t + b * t * t + c * t ** 3) / (a + b + c);
}

function easingIntegral(progress, smooth, range) {
  const t = clamp(progress, 0, 1);
  if (!smooth) return 0.5 * t ** 2;
  const [a, b, c] = easingCoefficients(range);
  return (a * t * t / 2 + b * t ** 3 / 3 + c * t ** 4 / 4) / (a + b + c);
}

export function getVisualSpeedCurveAverageRate(value) {
  const curve = normalizeVisualSpeedCurve(value);
  return curve.points.slice(0, -1).reduce((total, point, index) => {
    const next = curve.points[index + 1];
    return total + (next.progress - point.progress) * (point.rate
      + (next.rate - point.rate) * easingIntegral(1, curve.smooth, point.easingRange));
  }, 0) || 1;
}

export function getVisualSpeedCurveRateAtProgress(value, progress) {
  const curve = normalizeVisualSpeedCurve(value);
  const p = clamp(Number(progress) || 0, 0, 1);
  const rightIndex = curve.points.findIndex((point) => point.progress >= p);
  if (rightIndex <= 0) return curve.points[0].rate;
  const left = curve.points[rightIndex - 1];
  const right = curve.points[rightIndex];
  const local = (p - left.progress) / (right.progress - left.progress);
  return left.rate + (right.rate - left.rate) * easingValue(local, curve.smooth, left.easingRange);
}

export function getVisualSpeedCurveSourceProgress(value, progress) {
  const curve = normalizeVisualSpeedCurve(value);
  const p = clamp(Number(progress) || 0, 0, 1);
  const total = getVisualSpeedCurveAverageRate(curve);
  let integrated = 0;
  for (let index = 0; index < curve.points.length - 1; index += 1) {
    const left = curve.points[index];
    const right = curve.points[index + 1];
    const width = right.progress - left.progress;
    if (p >= right.progress) {
      integrated += width * (left.rate + (right.rate - left.rate) * easingIntegral(1, curve.smooth, left.easingRange));
      continue;
    }
    if (p > left.progress) {
      const local = (p - left.progress) / width;
      integrated += width * (left.rate * local + (right.rate - left.rate) * easingIntegral(local, curve.smooth, left.easingRange));
    }
    break;
  }
  return clamp(integrated / Math.max(0.0001, total), 0, 1);
}

export function getVisualSpeedCurveTimelineProgress(value, sourceProgress) {
  const target = clamp(Number(sourceProgress) || 0, 0, 1);
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (low + high) / 2;
    if (getVisualSpeedCurveSourceProgress(value, middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function sliceVisualSpeedCurve(value, startProgress, endProgress) {
  const curve = normalizeVisualSpeedCurve(value);
  const start = clamp(Number(startProgress) || 0, 0, 1);
  const end = clamp(Number(endProgress) || 0, 0, 1);
  if (end - start < 0.0001) throw Object.assign(new Error("Speed-curve slice is empty"), { code: "INVALID_RANGE" });
  const width = end - start;
  const points = [
    { id: start === 0 ? curve.points[0].id : "speed-slice-start", progress: 0, rate: getVisualSpeedCurveRateAtProgress(curve, start) },
    ...curve.points.filter(point => point.progress > start && point.progress < end).map(point => ({
      ...point,
      progress: (point.progress - start) / width,
    })),
    { id: end === 1 ? curve.points.at(-1).id : "speed-slice-end", progress: 1, rate: getVisualSpeedCurveRateAtProgress(curve, end) },
  ];
  for (let index = 0; index < points.length - 1; index++) {
    const from = start + points[index].progress * width;
    const to = start + points[index + 1].progress * width;
    const rightIndex = curve.points.findIndex(point => point.progress > (from + to) / 2);
    const left = curve.points[rightIndex - 1], right = curve.points[rightIndex];
    const [a, b] = left.easingRange || [0, 1];
    points[index].easingRange = [from, to].map(progress =>
      clamp(a + (b - a) * (progress - left.progress) / (right.progress - left.progress), a, b));
  }
  return normalizeVisualSpeedCurve({ enabled: true, smooth: curve.smooth, points });
}

export function updateVisualSegmentSpeedCurve(segment, value) {
  const previousDuration = Math.max(MIN_VISUAL_SEGMENT_SECONDS, Number(segment?.duration) || MIN_VISUAL_SEGMENT_SECONDS);
  const previousRate = Math.max(MIN_VISUAL_PLAYBACK_RATE, Number(segment?.playbackRate) || 1);
  const sourceDuration = Math.max(MIN_VISUAL_SEGMENT_SECONDS, Number(segment?.sourceDuration) || previousDuration * previousRate);
  const speedCurve = { ...normalizeVisualSpeedCurve(value), enabled: true };
  const playbackRate = getVisualSpeedCurveAverageRate(speedCurve);
  const duration = clamp(sourceDuration / playbackRate, MIN_VISUAL_SEGMENT_SECONDS, MAX_TIMELINE_DURATION_SECONDS);
  const timeScale = duration / previousDuration;
  return {
    ...segment,
    playbackRate,
    sourceDuration,
    duration,
    speedCurve,
    keyframes: normalizeVisualKeyframes(segment?.keyframes).map((frame) => ({
      ...frame,
      time: Math.min(duration, frame.time * timeScale),
    })),
  };
}

export function resetVisualSegmentSpeedCurve(segment) {
  return updateVisualSegmentSpeedCurve(segment, {
    enabled: true,
    smooth: true,
    points: DEFAULT_VISUAL_SPEED_CURVE_POINTS,
  });
}
