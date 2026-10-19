import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
} from "mediabunny";
import { analyzeVisualSubject, warmVisualSubjectModels } from "./vision.js";
import { MODNET_MODEL_ID, MODNET_MODEL_REVISION } from "../config/models.js";
import {
  applySoftSubjectGate,
  disposeMediaPipePersonSegmenter,
  getMediaPipePersonSegmenter,
  segmentMediaPipePersonRoi,
} from "./mediapipePersonSegmentation.js";
import {
  detectObjectsWithNanoDet,
  disposeObjectSegmentationModels,
  prepareObjectSegmenter,
  segmentObjectWithMagicTouch,
  selectPrimaryObject,
} from "./objectSegmentation.js";

const SLIMSAM_MODEL_ID = "Xenova/slimsam-77-uniform";
const SLIMSAM_MODEL_REVISION = "5850ab45f587c112167512ffef949107115e26a0";
const FLOW_FPS = 8;
const ANCHOR_FPS = 1;

const pendingSlimSamRequests = new Map();
const pendingFlowRequests = new Map();
let slimSamWorker = null;
let flowWorker = null;
let flowReadyPromise = null;

function createRequestId(prefix) {
  return globalThis.crypto?.randomUUID
    ? `${prefix}-${globalThis.crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createAbortError() {
  if (typeof DOMException !== "undefined") {
    return new DOMException("人物描边分析已取消。", "AbortError");
  }
  const error = new Error("人物描边分析已取消。");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function settleRequest(map, requestId, callback) {
  const request = map.get(requestId);
  if (!request) return;
  map.delete(requestId);
  request.signal?.removeEventListener("abort", request.handleAbort);
  callback(request);
}

function rejectRequests(map, error) {
  map.forEach((request) => {
    request.signal?.removeEventListener("abort", request.handleAbort);
    request.reject(error);
  });
  map.clear();
}

function resetSlimSamWorker(error = null) {
  slimSamWorker?.terminate();
  slimSamWorker = null;
  if (error) rejectRequests(pendingSlimSamRequests, error);
}

function resetFlowWorker(error = null) {
  flowWorker?.terminate();
  flowWorker = null;
  flowReadyPromise = null;
  if (error) rejectRequests(pendingFlowRequests, error);
}

function getSlimSamWorker() {
  if (slimSamWorker) return slimSamWorker;
  if (typeof Worker === "undefined") throw new Error("当前浏览器不支持 SlimSAM Worker。");
  slimSamWorker = new Worker(new URL("../workers/slimsam.worker.js", import.meta.url), { type: "module" });
  slimSamWorker.addEventListener("message", (event) => {
    const message = event.data;
    const request = pendingSlimSamRequests.get(message?.requestId);
    if (!request) return;
    if (message.type === "progress") {
      request.onProgress?.({
        progress: Math.max(0, Math.min(100, Number(message.progress) || 0)),
        phase: String(message.phase || ""),
      });
      return;
    }
    if (message.type === "result") {
      settleRequest(pendingSlimSamRequests, message.requestId, ({ resolve }) => resolve({
        ...message.result,
        mask: new Uint8ClampedArray(message.result.mask),
      }));
      return;
    }
    if (message.type === "error") {
      settleRequest(pendingSlimSamRequests, message.requestId, ({ reject }) => {
        reject(new Error(message.error || "SlimSAM 人物分割失败。"));
      });
    }
  });
  slimSamWorker.addEventListener("error", (event) => {
    resetSlimSamWorker(new Error(event.message || "SlimSAM Worker 运行失败。"));
  });
  return slimSamWorker;
}

function getFlowWorker() {
  if (flowWorker && flowReadyPromise) return { worker: flowWorker, ready: flowReadyPromise };
  if (typeof Worker === "undefined") throw new Error("当前浏览器不支持光流 Worker。");
  flowWorker = new Worker(new URL("../workers/person-flow.worker.js", import.meta.url));
  flowReadyPromise = new Promise((resolve, reject) => {
    const handleMessage = (event) => {
      if (event.data?.type === "ready") resolve(event.data);
      if (event.data?.type === "fatal") reject(new Error(event.data.error || "OpenCV 光流初始化失败。"));
    };
    flowWorker.addEventListener("message", handleMessage);
  });
  flowWorker.addEventListener("message", (event) => {
    const message = event.data;
    const request = pendingFlowRequests.get(message?.requestId);
    if (!request) return;
    if (message.type === "result") {
      settleRequest(pendingFlowRequests, message.requestId, ({ resolve }) => resolve({
        ...message.result,
        alpha: message.result?.alpha ? new Uint8ClampedArray(message.result.alpha) : null,
        rgba: message.result?.rgba ? new Uint8ClampedArray(message.result.rgba) : null,
      }));
    } else if (message.type === "error") {
      settleRequest(pendingFlowRequests, message.requestId, ({ reject }) => {
        reject(new Error(message.error || "人物光流传播失败。"));
      });
    }
  });
  flowWorker.addEventListener("error", (event) => {
    resetFlowWorker(new Error(event.message || "人物光流 Worker 运行失败。"));
  });
  return { worker: flowWorker, ready: flowReadyPromise };
}

function requestSlimSam({ blob, box, point = null, negativePoints, signal, onProgress }) {
  throwIfAborted(signal);
  const worker = getSlimSamWorker();
  const requestId = createRequestId("slimsam");
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      settleRequest(pendingSlimSamRequests, requestId, (request) => request.reject(createAbortError()));
      resetSlimSamWorker();
    };
    pendingSlimSamRequests.set(requestId, {
      resolve, reject, signal, onProgress, handleAbort,
    });
    signal?.addEventListener("abort", handleAbort, { once: true });
    worker.postMessage({ requestId, type: "segment", blob, box, point, negativePoints });
  });
}

async function requestFlow(type, payload, signal) {
  throwIfAborted(signal);
  const { worker, ready } = getFlowWorker();
  await ready;
  throwIfAborted(signal);
  const requestId = createRequestId("flow");
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      settleRequest(pendingFlowRequests, requestId, (request) => request.reject(createAbortError()));
      resetFlowWorker();
    };
    pendingFlowRequests.set(requestId, { resolve, reject, signal, handleAbort });
    signal?.addEventListener("abort", handleAbort, { once: true });
    const message = { requestId, type, ...payload };
    const transfer = [];
    if (message.rgba instanceof ArrayBuffer) transfer.push(message.rgba);
    if (message.alpha instanceof ArrayBuffer) transfer.push(message.alpha);
    worker.postMessage(message, transfer);
  });
}

function waitForEvent(target, eventName, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, handleSuccess);
      target.removeEventListener("error", handleError);
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleSuccess = () => { cleanup(); resolve(); };
    const handleError = () => { cleanup(); reject(new Error("无法读取人物描边视频。")); };
    const handleAbort = () => { cleanup(); reject(createAbortError()); };
    target.addEventListener(eventName, handleSuccess, { once: true });
    target.addEventListener("error", handleError, { once: true });
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function ensureVideoReady(video, signal) {
  if (video.readyState < 1) await waitForEvent(video, "loadedmetadata", signal);
  if (video.readyState < 2) await waitForEvent(video, "loadeddata", signal);
}

async function seekVideo(video, requestedTime, signal) {
  await ensureVideoReady(video, signal);
  const duration = Number.isFinite(video.duration) ? video.duration : requestedTime;
  const time = Math.max(0, Math.min(requestedTime, Math.max(0, duration - 0.001)));
  if (Math.abs(video.currentTime - time) <= 0.008) return;
  const complete = waitForEvent(video, "seeked", signal);
  video.currentTime = time;
  await complete;
}

async function createSequentialFrameReader(src, sampleTimes, signal) {
  if (typeof VideoDecoder === "undefined") return null;
  let input = null;
  try {
    const blob = src instanceof Blob
      ? src
      : await fetch(String(src), { signal }).then((response) => {
          if (!response.ok) throw new Error(`视频读取失败 (${response.status})`);
          return response.blob();
        });
    throwIfAborted(signal);
    input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) {
      throw new Error("当前视频编码不支持 WebCodecs 硬件解码");
    }
    const sink = new CanvasSink(track, {
      poolSize: 3,
      decoderOptions: { optimizeForLatency: true },
    });
    const iterator = sink.canvasesAtTimestamps(sampleTimes)[Symbol.asyncIterator]();
    return {
      mode: "sequential-webcodecs",
      async next() {
        throwIfAborted(signal);
        const result = await iterator.next();
        return result.done ? null : result.value?.canvas || null;
      },
      async dispose() {
        await iterator.return?.();
        input?.dispose();
      },
    };
  } catch (error) {
    input?.dispose();
    console.warn("人物描边顺序硬解码不可用，回退精确 seek。", error);
    return null;
  }
}

function canvasToBlob(canvas, type = "image/png", quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("人物帧编码失败。")), type, quality);
  });
}

export function getPersonOutlineSampleTimes(duration, fps = FLOW_FPS, maxSamples = 360) {
  const safeDuration = Math.max(0.05, Number(duration) || 0.05);
  const count = Math.min(
    Math.max(2, Math.floor(safeDuration * Math.max(1, fps)) + 1),
    Math.max(2, maxSamples),
  );
  const step = safeDuration / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, index) => Number((index * step).toFixed(6)));
}

export function shouldDelayPersonAnchor({
  framesSinceAnchor,
  anchorEvery,
  maxAnchorEvery,
  trackedMaskBox,
  areaRatio = 1,
  meanMotion = Infinity,
  roiFallback = true,
} = {}) {
  if (framesSinceAnchor < anchorEvery || framesSinceAnchor >= maxAnchorEvery) return false;
  return Boolean(
    trackedMaskBox
    && !roiFallback
    && areaRatio >= 0.82
    && areaRatio <= 1.22
    && meanMotion <= 1.35,
  );
}

function toPixelBox(box, width, height) {
  if (!box) return null;
  return {
    xmin: Math.max(0, Math.min(width, Number(box.xmin) * width)),
    ymin: Math.max(0, Math.min(height, Number(box.ymin) * height)),
    xmax: Math.max(0, Math.min(width, Number(box.xmax) * width)),
    ymax: Math.max(0, Math.min(height, Number(box.ymax) * height)),
  };
}

function boxIoU(left, right) {
  if (!left || !right) return 0;
  const width = Math.max(0, Math.min(left.xmax, right.xmax) - Math.max(left.xmin, right.xmin));
  const height = Math.max(0, Math.min(left.ymax, right.ymax) - Math.max(left.ymin, right.ymin));
  const intersection = width * height;
  const leftArea = Math.max(0, left.xmax - left.xmin) * Math.max(0, left.ymax - left.ymin);
  const rightArea = Math.max(0, right.xmax - right.xmin) * Math.max(0, right.ymax - right.ymin);
  return intersection / Math.max(1, leftArea + rightArea - intersection);
}

function getMaskComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (visited[start] || mask[start] < 96) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const pixels = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      pixels.push(index);
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length || visited[next] || mask[next] < 96) continue;
        const nextX = next % width;
        if (Math.abs(nextX - x) > 1) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    components.push({
      pixels,
      area: pixels.length,
      centerX: sumX / pixels.length,
      centerY: sumY / pixels.length,
      box: { xmin: minX, ymin: minY, xmax: maxX + 1, ymax: maxY + 1 },
    });
  }
  return components;
}

export function selectPersonMask(mask, width, height, detectionBox, previousBox = null) {
  const detected = toPixelBox(detectionBox, width, height);
  if (!detected || !(mask instanceof Uint8Array || mask instanceof Uint8ClampedArray)) return null;
  const detectedCenterX = (detected.xmin + detected.xmax) / 2;
  const detectedCenterY = (detected.ymin + detected.ymax) / 2;
  const detectedWidth = Math.max(1, detected.xmax - detected.xmin);
  const detectedHeight = Math.max(1, detected.ymax - detected.ymin);
  const detectedArea = detectedWidth * detectedHeight;
  const components = getMaskComponents(mask, width, height)
    .filter((component) => component.area >= Math.max(48, detectedArea * 0.04))
    .map((component) => {
      const centerDistance = Math.hypot(
        (component.centerX - detectedCenterX) / detectedWidth,
        (component.centerY - detectedCenterY) / detectedHeight,
      );
      const detectionIou = boxIoU(component.box, detected);
      const previousIou = previousBox ? boxIoU(component.box, previousBox) : 0;
      const areaRatio = component.area / detectedArea;
      const componentHeight = Math.max(1, component.box.ymax - component.box.ymin);
      const heightRatio = componentHeight / detectedHeight;
      const lowerThreshold = detected.ymin + detectedHeight * 0.52;
      const lowerBodyPixels = component.pixels.reduce(
        (count, index) => count + (Math.floor(index / width) >= lowerThreshold ? 1 : 0),
        0,
      );
      const lowerBodyRatio = lowerBodyPixels / Math.max(1, component.area);
      const sideMargin = detectedWidth * 0.06;
      const sideSpillPixels = component.pixels.reduce((count, index) => {
        const x = index % width;
        return count + (x < detected.xmin - sideMargin || x >= detected.xmax + sideMargin ? 1 : 0);
      }, 0);
      const lowerSideSpillPixels = component.pixels.reduce((count, index) => {
        const x = index % width;
        const y = Math.floor(index / width);
        return count + (
          y >= lowerThreshold
          && (x < detected.xmin - sideMargin || x >= detected.xmax + sideMargin)
            ? 1
            : 0
        );
      }, 0);
      const sideSpillRatio = sideSpillPixels / Math.max(1, component.area);
      const lowerSideSpillRatio = lowerSideSpillPixels / Math.max(1, lowerBodyPixels);
      const widthRatio = Math.max(1, component.box.xmax - component.box.xmin) / detectedWidth;
      const overflowX = Math.max(0, detected.xmin - component.box.xmin)
        + Math.max(0, component.box.xmax - detected.xmax);
      const overflowY = Math.max(0, detected.ymin - component.box.ymin)
        + Math.max(0, component.box.ymax - detected.ymax);
      const overflowRatio = overflowX / detectedWidth + overflowY / detectedHeight;
      const score = detectionIou * 0.5 + previousIou * 0.2
        + Math.max(0, 1 - centerDistance) * 0.3
        - Math.max(0, areaRatio - 1.35) * 0.4
        - sideSpillRatio * 0.8
        - lowerSideSpillRatio * 0.65
        - overflowRatio * 0.35;
      return {
        ...component,
        centerDistance,
        detectionIou,
        previousIou,
        areaRatio,
        heightRatio,
        lowerBodyRatio,
        sideSpillRatio,
        lowerSideSpillRatio,
        widthRatio,
        overflowRatio,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);
  const selected = components[0];
  if (!selected
    || selected.centerDistance > 0.72
    || selected.detectionIou < 0.04
    || selected.areaRatio < 0.12
    || selected.areaRatio > 1.55
    || selected.heightRatio < 0.5
    || selected.lowerBodyRatio < 0.12
    || (selected.widthRatio > 1.12 && selected.sideSpillRatio > 0.16)
    || (selected.widthRatio > 1.08 && selected.lowerSideSpillRatio > 0.22)
    || selected.overflowRatio > 0.62
    || (previousBox && selected.previousIou < 0.015 && selected.centerDistance > 0.42)) {
    return null;
  }
  const cleaned = new Uint8ClampedArray(width * height);
  selected.pixels.forEach((index) => { cleaned[index] = mask[index]; });
  return { alpha: cleaned, box: selected.box, metrics: selected };
}

export function selectObjectMask(mask, width, height, detectionBox, point, previousBox = null) {
  const detected = toPixelBox(detectionBox, width, height);
  if (!detected || !(mask instanceof Uint8Array || mask instanceof Uint8ClampedArray)) return null;
  const detectedWidth = Math.max(1, detected.xmax - detected.xmin);
  const detectedHeight = Math.max(1, detected.ymax - detected.ymin);
  const detectedArea = detectedWidth * detectedHeight;
  const pointX = Math.max(0, Math.min(width - 1, Math.round((Number(point?.x) || 0.5) * width)));
  const pointY = Math.max(0, Math.min(height - 1, Math.round((Number(point?.y) || 0.5) * height)));
  const detectedCenterX = (detected.xmin + detected.xmax) / 2;
  const detectedCenterY = (detected.ymin + detected.ymax) / 2;
  const components = getMaskComponents(mask, width, height)
    .filter((component) => component.area >= Math.max(24, detectedArea * 0.025))
    .map((component) => {
      const containsPoint = pointX >= component.box.xmin && pointX < component.box.xmax
        && pointY >= component.box.ymin && pointY < component.box.ymax
        && mask[pointY * width + pointX] >= 96;
      const centerDistance = Math.hypot(
        (component.centerX - detectedCenterX) / detectedWidth,
        (component.centerY - detectedCenterY) / detectedHeight,
      );
      const detectionIou = boxIoU(component.box, detected);
      const previousIou = previousBox ? boxIoU(component.box, previousBox) : 0;
      const areaRatio = component.area / detectedArea;
      const overflowX = Math.max(0, detected.xmin - component.box.xmin)
        + Math.max(0, component.box.xmax - detected.xmax);
      const overflowY = Math.max(0, detected.ymin - component.box.ymin)
        + Math.max(0, component.box.ymax - detected.ymax);
      const overflowRatio = overflowX / detectedWidth + overflowY / detectedHeight;
      const score = (containsPoint ? 1.4 : -0.8)
        + detectionIou * 0.8
        + previousIou * 0.65
        + Math.max(0, 1 - centerDistance) * 0.35
        - Math.max(0, areaRatio - 1.7) * 0.45
        - overflowRatio * 0.28;
      return {
        ...component,
        containsPoint,
        centerDistance,
        detectionIou,
        previousIou,
        areaRatio,
        overflowRatio,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);
  const selected = components[0];
  if (!selected
    || !selected.containsPoint
    || selected.centerDistance > 0.95
    || selected.detectionIou < 0.025
    || selected.areaRatio < 0.04
    || selected.areaRatio > 2.4
    || selected.overflowRatio > 1.25
    || (previousBox && selected.previousIou < 0.01 && selected.centerDistance > 0.5)) {
    return null;
  }
  const cleaned = new Uint8ClampedArray(width * height);
  selected.pixels.forEach((index) => { cleaned[index] = mask[index]; });
  return { alpha: cleaned, box: selected.box, metrics: selected };
}

function normalizeSubjectBox(pixelBox, width, height) {
  if (!pixelBox) return null;
  return {
    xmin: pixelBox.xmin / width,
    ymin: pixelBox.ymin / height,
    xmax: pixelBox.xmax / width,
    ymax: pixelBox.ymax / height,
  };
}

function getAlphaBox(alpha, width, height) {
  let xmin = width;
  let ymin = height;
  let xmax = -1;
  let ymax = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (alpha[row + x] < 96) continue;
      xmin = Math.min(xmin, x);
      ymin = Math.min(ymin, y);
      xmax = Math.max(xmax, x);
      ymax = Math.max(ymax, y);
    }
  }
  return xmax >= xmin && ymax >= ymin
    ? { xmin, ymin, xmax: xmax + 1, ymax: ymax + 1 }
    : null;
}

function expandNormalizedBox(box, padding = 0.16) {
  if (!box) return null;
  const width = Math.max(0.01, Number(box.xmax) - Number(box.xmin));
  const height = Math.max(0.01, Number(box.ymax) - Number(box.ymin));
  return {
    xmin: Math.max(0, Number(box.xmin) - width * padding),
    ymin: Math.max(0, Number(box.ymin) - height * padding),
    xmax: Math.min(1, Number(box.xmax) + width * padding),
    ymax: Math.min(1, Number(box.ymax) + height * padding),
  };
}

function getNegativePersonPoints(detections, target) {
  return (detections || [])
    .filter((item) => String(item.label).toLowerCase() === "person"
      && boxIoU(item.box, target?.box) < 0.55)
    .map((item) => ({
      x: (Number(item.box?.xmin) + Number(item.box?.xmax)) / 2,
      y: Number(item.box?.ymin) + (Number(item.box?.ymax) - Number(item.box?.ymin)) * 0.42,
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice(0, 4);
}

export function getMaskSpillNegativePoints(alpha, width, height, detectionBox) {
  const detected = toPixelBox(detectionBox, width, height);
  if (!detected || !(alpha instanceof Uint8Array || alpha instanceof Uint8ClampedArray)) return [];
  const detectedWidth = Math.max(1, detected.xmax - detected.xmin);
  const detectedHeight = Math.max(1, detected.ymax - detected.ymin);
  const sideMargin = detectedWidth * 0.05;
  const lowerThreshold = detected.ymin + detectedHeight * 0.48;
  const regions = {
    left: { x: 0, y: 0, count: 0 },
    right: { x: 0, y: 0, count: 0 },
    bottom: { x: 0, y: 0, count: 0 },
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (alpha[row + x] < 96) continue;
      let region = null;
      if (y >= lowerThreshold && x < detected.xmin - sideMargin) region = regions.left;
      else if (y >= lowerThreshold && x >= detected.xmax + sideMargin) region = regions.right;
      else if (y >= detected.ymax + detectedHeight * 0.04) region = regions.bottom;
      if (!region) continue;
      region.x += x;
      region.y += y;
      region.count += 1;
    }
  }
  return Object.values(regions)
    .filter((region) => region.count >= Math.max(12, width * height * 0.0015))
    .map((region) => ({
      x: region.x / region.count / width,
      y: region.y / region.count / height,
    }))
    .slice(0, 3);
}

function mergeNegativePoints(...groups) {
  const merged = [];
  groups.flat().forEach((point) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    if (merged.some((item) => Math.hypot(item.x - point.x, item.y - point.y) < 0.045)) return;
    merged.push(point);
  });
  return merged.slice(0, 4);
}

async function makeCutoutBlob(frameRgba, alpha, width, height, canvas, context) {
  const pixels = new Uint8ClampedArray(frameRgba);
  for (let index = 0; index < alpha.length; index += 1) {
    pixels[index * 4 + 3] = alpha[index];
  }
  context.clearRect(0, 0, width, height);
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvasToBlob(canvas, "image/png");
}

async function decodeCutoutAlpha(blob, width, height, canvas, context) {
  if (!(blob instanceof Blob) || !blob.size) return null;
  const bitmap = await createImageBitmap(blob);
  try {
    context.clearRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const alpha = new Uint8ClampedArray(width * height);
    for (let index = 0; index < alpha.length; index += 1) {
      alpha[index] = rgba[index * 4 + 3];
    }
    return alpha;
  } finally {
    bitmap.close?.();
  }
}

/**
 * Video portrait analysis optimized for editor effects:
 * YOLOS locks one person, ROI MODNet creates the preferred complete-person
 * anchor, SlimSAM is a guarded fallback, and ROI Farneback flow propagates
 * accepted masks to 8 fps preview/export samples.
 */
export async function analyzePersonOutlineVideo(options = {}) {
  const {
    src,
    duration: requestedDuration,
    maxDimension = 360,
    flowFps = FLOW_FPS,
    anchorFps = ANCHOR_FPS,
    maxSamples = 360,
    signal,
    onProgress,
    onSample,
  } = options;
  if (!src) throw new TypeError("人物描边分析需要视频源。");
  throwIfAborted(signal);

  const warmupStartedAt = performance.now();
  const visionWarmup = warmVisualSubjectModels({
    includeDetector: true,
    includeMatting: true,
    signal,
    onProgress: ({ phase }) => onProgress?.({ progress: 1, phase }),
  }).catch((error) => {
    if (error?.name === "AbortError") throw error;
    console.warn("人物模型预热失败，将在首个锚点重试。", error);
    return null;
  });
  const mediaPipeWarmup = getMediaPipePersonSegmenter().catch((error) => {
    console.warn("MediaPipe 预热失败，将保留 MODNet/SlimSAM 路径。", error);
    return null;
  });
  const flowWarmup = Promise.resolve().then(() => getFlowWorker().ready);
  const warmupComplete = Promise.allSettled([
    visionWarmup,
    mediaPipeWarmup,
    flowWarmup,
  ]).then(() => performance.now() - warmupStartedAt);

  const objectUrl = src instanceof Blob ? URL.createObjectURL(src) : "";
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = objectUrl || String(src);
  await ensureVideoReady(video, signal);

  const sourceSize = { width: video.videoWidth, height: video.videoHeight };
  const scale = Math.min(1, maxDimension / Math.max(sourceSize.width, sourceSize.height));
  const targetSize = {
    width: Math.max(2, Math.round(sourceSize.width * scale)),
    height: Math.max(2, Math.round(sourceSize.height * scale)),
  };
  const duration = Math.max(
    0.05,
    Math.min(Number(video.duration) || requestedDuration || 0.05, Number(requestedDuration) || video.duration || 0.05),
  );
  const sampleTimes = getPersonOutlineSampleTimes(duration, flowFps, maxSamples);
  const anchorEvery = Math.max(1, Math.round(flowFps / Math.max(0.1, anchorFps)));
  const maxAnchorEvery = Math.max(anchorEvery, Math.round(flowFps * 5));
  const fullAnchorEvery = Math.max(anchorEvery, Math.round(flowFps * 8));
  const canvas = document.createElement("canvas");
  canvas.width = targetSize.width;
  canvas.height = targetSize.height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  const cutoutCanvas = document.createElement("canvas");
  cutoutCanvas.width = targetSize.width;
  cutoutCanvas.height = targetSize.height;
  const cutoutContext = cutoutCanvas.getContext("2d", { alpha: true });
  if (!context || !cutoutContext) throw new Error("无法创建人物描边分析画布。");

  const samples = [];
  let trackedDetectionBox = null;
  let trackedMaskBox = null;
  let trackedMaskArea = 0;
  let currentAlpha = null;
  let flowInitialized = false;
  let lastAnchorIndex = -anchorEvery;
  let lastFullAnchorIndex = -fullAnchorEvery;
  let firstModelInfo = null;
  const startedAt = performance.now();
  let sequentialFrameReader = null;
  const timings = {
    decodeMs: 0,
    pixelReadMs: 0,
    flowMs: 0,
    anchorMs: 0,
    cutoutEncodeMs: 0,
    callbackMs: 0,
    seekFallbackFrames: 0,
    adaptiveDelayedAnchors: 0,
    transferredFrameBuffers: 0,
    fastRefreshAttempts: 0,
    fastRefreshAnchors: 0,
    fullModelAnchors: 0,
    slimSamFallbacks: 0,
  };

  try {
    onProgress?.({ progress: 1, phase: "初始化人物抠像与 ROI 光流" });
    sequentialFrameReader = await createSequentialFrameReader(src, sampleTimes, signal);
    for (let index = 0; index < sampleTimes.length; index += 1) {
      throwIfAborted(signal);
      const time = sampleTimes[index];
      const decodeStartedAt = performance.now();
      const decodedCanvas = sequentialFrameReader
        ? await sequentialFrameReader.next()
        : null;
      if (!decodedCanvas) {
        timings.seekFallbackFrames += 1;
        await seekVideo(video, time, signal);
      }
      context.fillStyle = "#000";
      context.fillRect(0, 0, targetSize.width, targetSize.height);
      context.drawImage(decodedCanvas || video, 0, 0, targetSize.width, targetSize.height);
      timings.decodeMs += performance.now() - decodeStartedAt;
      const pixelReadStartedAt = performance.now();
      const imageData = context.getImageData(0, 0, targetSize.width, targetSize.height);
      let frameRgba = new Uint8ClampedArray(imageData.data);
      timings.pixelReadMs += performance.now() - pixelReadStartedAt;
      let source = "flow";
      let detections = [];
      let detectedSubject = null;
      let flowDurationMs = 0;
      let acceptedAnchor = false;
      let flowAreaRatio = 1;
      let flowMeanMotion = Infinity;
      let flowRoiFallback = true;

      if (flowInitialized && index > 0) {
        const flowStartedAt = performance.now();
        const propagated = await requestFlow("step", {
          rgba: frameRgba.buffer,
        }, signal);
        timings.transferredFrameBuffers += 1;
        timings.flowMs += performance.now() - flowStartedAt;
        frameRgba = propagated.rgba || frameRgba;
        currentAlpha = propagated.alpha;
        trackedMaskBox = getAlphaBox(currentAlpha, targetSize.width, targetSize.height);
        const nextArea = trackedMaskBox
          ? (trackedMaskBox.xmax - trackedMaskBox.xmin) * (trackedMaskBox.ymax - trackedMaskBox.ymin)
          : 0;
        flowAreaRatio = trackedMaskArea > 0 ? nextArea / trackedMaskArea : 1;
        flowMeanMotion = Number(propagated.meanMotion);
        flowRoiFallback = Boolean(propagated.roi?.fallback);
        if (!trackedMaskBox || flowAreaRatio < 0.28 || flowAreaRatio > 3.2) {
          currentAlpha = new Uint8ClampedArray(targetSize.width * targetSize.height);
          trackedMaskBox = null;
          trackedMaskArea = 0;
        } else {
          trackedMaskArea = nextArea;
        }
        flowDurationMs = Number(propagated.durationMs) || 0;
      }

      const framesSinceAnchor = index - lastAnchorIndex;
      const delayScheduledAnchor = shouldDelayPersonAnchor({
        framesSinceAnchor,
        anchorEvery,
        maxAnchorEvery,
        trackedMaskBox,
        areaRatio: flowAreaRatio,
        meanMotion: flowMeanMotion,
        roiFallback: flowRoiFallback,
      });
      if (delayScheduledAnchor && framesSinceAnchor === anchorEvery) {
        timings.adaptiveDelayedAnchors += 1;
      }
      const isAnchor = index === 0
        || (framesSinceAnchor >= anchorEvery && !delayScheduledAnchor)
        || (!trackedMaskBox && framesSinceAnchor >= Math.min(anchorEvery, Math.round(flowFps)));
      if (isAnchor) {
        const anchorStartedAt = performance.now();
        lastAnchorIndex = index;
        onProgress?.({
          progress: (index / sampleTimes.length) * 100,
          phase: `完整人像锚点 ${Math.floor(index / anchorEvery) + 1}`,
        });
        const trackedBox = trackedMaskBox
          ? expandNormalizedBox(normalizeSubjectBox(trackedMaskBox, targetSize.width, targetSize.height))
          : null;
        const canUseFastRefresh = index > 0
          && trackedBox
          && index - lastFullAnchorIndex < fullAnchorEvery
          && flowAreaRatio >= 0.45
          && flowAreaRatio <= 2.1;
        if (canUseFastRefresh) {
          timings.fastRefreshAttempts += 1;
          try {
            detectedSubject = {
              label: "person",
              score: 1,
              box: trackedBox,
            };
            detections = [detectedSubject];
            onProgress?.({
              progress: (index / sampleTimes.length) * 100,
              phase: `帧 ${index + 1}/${sampleTimes.length} · MediaPipe 快速刷新主体`,
            });
            const mediaPipeMask = await segmentMediaPipePersonRoi(
              canvas,
              trackedBox,
              { threshold: 0.46, morphologyRadius: 1 },
            );
            const refreshed = selectPersonMask(
              mediaPipeMask.alpha,
              targetSize.width,
              targetSize.height,
              trackedBox,
              trackedMaskBox,
            );
            if (refreshed) {
              currentAlpha = applySoftSubjectGate(
                currentAlpha,
                refreshed.alpha,
                targetSize.width,
                targetSize.height,
              );
              const selected = selectPersonMask(
                currentAlpha,
                targetSize.width,
                targetSize.height,
                trackedBox,
                trackedMaskBox,
              );
              if (selected) {
                currentAlpha = selected.alpha;
                trackedMaskBox = selected.box;
                trackedMaskArea = selected.metrics.area;
                trackedDetectionBox = normalizeSubjectBox(selected.box, targetSize.width, targetSize.height);
                source = "mediapipe-flow-refresh";
                acceptedAnchor = true;
                timings.fastRefreshAnchors += 1;
              }
            }
          } catch {
            // Fall through to the full MODNet anchor below.
          }
        }
        if (!acceptedAnchor) {
          timings.fullModelAnchors += 1;
          lastFullAnchorIndex = index;
          const frameBlob = await canvasToBlob(canvas, "image/jpeg", 0.88);
          let matteResult = null;
          if (trackedMaskBox) {
          const trackedBox = expandNormalizedBox(
            normalizeSubjectBox(trackedMaskBox, targetSize.width, targetSize.height),
          );
          detectedSubject = {
            label: "person",
            score: 1,
            box: trackedBox,
          };
          detections = [detectedSubject];
          matteResult = await analyzeVisualSubject({
            blob: frameBlob,
            includeMatting: true,
            skipDetection: true,
            targetBox: trackedBox,
            signal,
            onProgress: ({ phase }) => onProgress?.({
              progress: (index / sampleTimes.length) * 100,
              phase: `帧 ${index + 1}/${sampleTimes.length} · ${phase}`,
            }),
          });
          } else {
          matteResult = await analyzeVisualSubject({
            blob: frameBlob,
            includeMatting: true,
            threshold: 0.28,
            preferredLabels: ["person"],
            targetBox: trackedDetectionBox,
            signal,
            onProgress: ({ phase }) => onProgress?.({
              progress: (index / sampleTimes.length) * 100,
              phase: `帧 ${index + 1}/${sampleTimes.length} · ${phase}`,
            }),
          });
          detections = (matteResult.detections || []).filter((item) => String(item.label).toLowerCase() === "person");
          detectedSubject = matteResult.detectedSubject || matteResult.subject;
          }
          if (detectedSubject?.box) {
          const matteAlpha = await decodeCutoutAlpha(
            matteResult?.cutoutBlob,
            targetSize.width,
            targetSize.height,
            cutoutCanvas,
            cutoutContext,
          );
          let selected = null;
          if (matteAlpha) {
            try {
              onProgress?.({
                progress: (index / sampleTimes.length) * 100,
                phase: `帧 ${index + 1}/${sampleTimes.length} · MediaPipe 清理主体外溢`,
              });
              const mediaPipeMask = await segmentMediaPipePersonRoi(
                canvas,
                detectedSubject.box,
                { threshold: 0.46, morphologyRadius: 1 },
              );
              const mediaPipeSubject = selectPersonMask(
                mediaPipeMask.alpha,
                targetSize.width,
                targetSize.height,
                detectedSubject.box,
                trackedMaskBox,
              );
              if (mediaPipeSubject) {
                const fusedAlpha = applySoftSubjectGate(
                  matteAlpha,
                  mediaPipeSubject.alpha,
                  targetSize.width,
                  targetSize.height,
                );
                selected = selectPersonMask(
                  fusedAlpha,
                  targetSize.width,
                  targetSize.height,
                  detectedSubject.box,
                  trackedMaskBox,
                );
                if (selected) source = "modnet-mediapipe-gated";
              }
            } catch {
              // MediaPipe is an optional fast gate. Preserve the existing
              // MODNet/SlimSAM recovery path when it is unavailable.
            }
          }
          selected ??= matteAlpha ? selectPersonMask(
            matteAlpha,
            targetSize.width,
            targetSize.height,
            detectedSubject.box,
            trackedMaskBox,
          ) : null;
          if (selected && source !== "modnet-mediapipe-gated") source = "modnet-roi";
          if (!selected) {
            const preservedFlow = currentAlpha && trackedMaskBox
              ? selectPersonMask(
                  currentAlpha,
                  targetSize.width,
                  targetSize.height,
                  detectedSubject.box,
                  trackedMaskBox,
                )
              : null;
            if (preservedFlow) {
              selected = preservedFlow;
              source = "flow-preserved-after-anchor-reject";
            } else {
              timings.slimSamFallbacks += 1;
              onProgress?.({
                progress: (index / sampleTimes.length) * 100,
                phase: `帧 ${index + 1}/${sampleTimes.length} · MODNet 不完整，尝试 SlimSAM`,
              });
              const segmented = await requestSlimSam({
                blob: frameBlob,
                box: detectedSubject.box,
                negativePoints: mergeNegativePoints(
                  getNegativePersonPoints(detections, detectedSubject),
                  getMaskSpillNegativePoints(
                    matteAlpha,
                    targetSize.width,
                    targetSize.height,
                    detectedSubject.box,
                  ),
                ),
                signal,
                onProgress: ({ phase }) => onProgress?.({
                  progress: (index / sampleTimes.length) * 100,
                  phase: `帧 ${index + 1}/${sampleTimes.length} · ${phase}`,
                }),
              });
              firstModelInfo ??= segmented;
              const slimSamSubject = selectPersonMask(
                segmented.mask,
                segmented.width,
                segmented.height,
                detectedSubject.box,
                trackedMaskBox,
              );
              if (slimSamSubject && matteAlpha) {
                const fusedAlpha = applySoftSubjectGate(
                  matteAlpha,
                  slimSamSubject.alpha,
                  targetSize.width,
                  targetSize.height,
                );
                selected = selectPersonMask(
                  fusedAlpha,
                  targetSize.width,
                  targetSize.height,
                  detectedSubject.box,
                  trackedMaskBox,
                );
                source = "modnet-slimsam-gated";
              } else {
                selected = slimSamSubject;
                source = "slimsam-fallback";
              }
            }
          }
          if (selected) {
            currentAlpha = selected.alpha;
            trackedMaskBox = selected.box;
            trackedMaskArea = selected.metrics.area;
            trackedDetectionBox = normalizeSubjectBox(selected.box, targetSize.width, targetSize.height);
            acceptedAnchor = true;
          } else {
            currentAlpha = new Uint8ClampedArray(targetSize.width * targetSize.height);
            trackedMaskBox = null;
            trackedMaskArea = 0;
            source = "quality-rejected";
          }
          } else {
          currentAlpha = new Uint8ClampedArray(targetSize.width * targetSize.height);
          trackedMaskBox = null;
          trackedMaskArea = 0;
          source = "person-lost";
          }
        }
        timings.anchorMs += performance.now() - anchorStartedAt;
      }

      currentAlpha ??= new Uint8ClampedArray(targetSize.width * targetSize.height);
      if (!flowInitialized) {
        const initialized = await requestFlow("init", {
          width: targetSize.width,
          height: targetSize.height,
          rgba: frameRgba.buffer,
          alpha: currentAlpha.slice().buffer,
        }, signal);
        timings.transferredFrameBuffers += 1;
        frameRgba = initialized.rgba || frameRgba;
        flowInitialized = true;
      } else if (isAnchor) {
        await requestFlow("resetAlpha", { alpha: currentAlpha.slice().buffer }, signal);
      }

      const visible = currentAlpha.some((value) => value >= 96);
      const subjectBox = visible ? normalizeSubjectBox(trackedMaskBox, targetSize.width, targetSize.height) : null;
      const cutoutStartedAt = performance.now();
      const cutoutBlob = visible
        ? await makeCutoutBlob(frameRgba, currentAlpha, targetSize.width, targetSize.height, cutoutCanvas, cutoutContext)
        : null;
      timings.cutoutEncodeMs += performance.now() - cutoutStartedAt;
      const subject = subjectBox ? {
        label: "person",
        score: Number(detectedSubject?.score) || 1,
        box: subjectBox,
      } : null;
      const sample = {
        time,
        sourceSize: targetSize,
        detections,
        detectedSubject,
        subject,
        cutoutBlob,
        tracking: {
          source,
          acceptedAnchor,
          flowDurationMs,
          meanMotion: Number.isFinite(flowMeanMotion) ? flowMeanMotion : null,
        },
      };
      samples.push(sample);
      const callbackStartedAt = performance.now();
      await onSample?.({ sample, index, total: sampleTimes.length, duration, sourceSize: targetSize });
      timings.callbackMs += performance.now() - callbackStartedAt;
      onProgress?.({
        progress: ((index + 1) / sampleTimes.length) * 100,
        phase: `逐帧描边 ${index + 1}/${sampleTimes.length} · ${subject ? "人物稳定" : "跳过不可靠帧"}`,
      });
    }

    if (!samples.some((sample) => sample.subject)) {
      throw new Error("未找到完整且可稳定锁定的人物，请更换人物更清晰的片段。");
    }
    const firstSubjectSample = samples.find((sample) => sample.subject);
    const elapsedMs = performance.now() - startedAt;
    const modelWarmupMs = await warmupComplete;
    const performanceSummary = {
      elapsedMs,
      modelWarmupMs,
      decodeMode: sequentialFrameReader?.mode || "precise-seek",
      frameCount: samples.length,
      millisecondsPerFrame: elapsedMs / Math.max(1, samples.length),
      realtimeFactor: elapsedMs / Math.max(1, duration * 1000),
      ...timings,
      flowFps,
      anchorFps,
      acceptedAnchors: samples.filter((sample) => sample.tracking.acceptedAnchor).length,
      rejectedAnchors: samples.filter((sample) => sample.tracking.source === "quality-rejected").length,
    };
    console.info("[Person Outline][Performance]", JSON.stringify(performanceSummary));
    return {
      kind: "video-timeline",
      pipeline: "portrait-hybrid-roi-flow",
      duration,
      sourceSize: targetSize,
      samples,
      subject: firstSubjectSample.subject,
      detections: firstSubjectSample.detections,
      complete: true,
      coverage: {
        start: samples[0]?.time || 0,
        end: samples.at(-1)?.time || 0,
        duration,
        sampleCount: samples.length,
        maxGap: samples.reduce((maximum, sample, index) => index
          ? Math.max(maximum, sample.time - samples[index - 1].time)
          : maximum, 0),
      },
      performance: performanceSummary,
      modelIds: {
        detector: "Xenova/yolos-tiny",
        matting: MODNET_MODEL_ID,
        fallbackMatting: SLIMSAM_MODEL_ID,
        propagation: "OpenCV Farneback ROI",
      },
      modelRevisions: {
        matting: MODNET_MODEL_REVISION,
        fallbackMatting: firstModelInfo?.modelRevision || SLIMSAM_MODEL_REVISION,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      resetSlimSamWorker();
      resetFlowWorker();
    }
    throw error;
  } finally {
    await sequentialFrameReader?.dispose?.();
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function objectPromptPoint(subject) {
  return {
    x: (Number(subject?.box?.xmin) + Number(subject?.box?.xmax)) / 2,
    y: (Number(subject?.box?.ymin) + Number(subject?.box?.ymax)) / 2,
  };
}

async function analyzeObjectAnchor({
  canvas,
  frameBlob,
  targetSize,
  previousSubject,
  previousMaskBox,
  reuseTrackedSubject = false,
  selectedSubject = null,
  signal,
  onProgress,
}) {
  const segmenterWarmup = prepareObjectSegmenter({ signal });
  let detection = null;
  let detectedSubject = selectedSubject || (reuseTrackedSubject && previousSubject && previousMaskBox
    ? {
        ...previousSubject,
        box: normalizeSubjectBox(previousMaskBox, targetSize.width, targetSize.height),
      }
    : null);
  if (!detectedSubject) {
    detection = await detectObjectsWithNanoDet({
      blob: frameBlob,
      signal,
      scoreThreshold: 0.22,
      onProgress,
    });
    detectedSubject = selectPrimaryObject(detection.detections, previousSubject);
  }
  if (!detectedSubject?.box) {
    await segmenterWarmup.catch(() => null);
    return {
      alpha: null,
      box: null,
      subject: null,
      detections: detection?.detections || [],
      source: "object-lost",
      detector: detection,
      segmenter: null,
    };
  }
  let point = objectPromptPoint(detectedSubject);
  let selected = null;
  let segmenter = null;
  let source = reuseTrackedSubject ? "magic-touch-track-refresh" : "magic-touch";
  const runMagicTouch = async () => {
    try {
      onProgress?.({ progress: 58, phase: "MagicTouch 快速分割实物" });
      await segmenterWarmup;
      segmenter = await segmentObjectWithMagicTouch(canvas, point, {
        signal,
        threshold: 0.48,
      });
      selected = selectObjectMask(
        segmenter.alpha,
        targetSize.width,
        targetSize.height,
        detectedSubject.box,
        point,
        previousMaskBox,
      );
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      console.warn("MagicTouch 实物蒙版不可用，准备重新检测或使用 SlimSAM。", error);
    }
  };
  await runMagicTouch();
  if (!selected && reuseTrackedSubject && !selectedSubject) {
    onProgress?.({ progress: 68, phase: "跟踪框刷新失败，NanoDet 重新识别实物" });
    detection = await detectObjectsWithNanoDet({
      blob: frameBlob,
      signal,
      scoreThreshold: 0.22,
      onProgress,
    });
    detectedSubject = selectPrimaryObject(detection.detections, previousSubject);
    if (detectedSubject?.box) {
      point = objectPromptPoint(detectedSubject);
      source = "magic-touch-redetect";
      await runMagicTouch();
    }
  }
  if (!selected) {
    onProgress?.({ progress: 76, phase: "MagicTouch 质量不足，SlimSAM 精修实物" });
    const segmented = await requestSlimSam({
      blob: frameBlob,
      box: detectedSubject.box,
      point,
      negativePoints: (detection?.detections || [])
        .filter((item) => item !== detectedSubject && boxIoU(
          toPixelBox(item.box, targetSize.width, targetSize.height),
          toPixelBox(detectedSubject.box, targetSize.width, targetSize.height),
        ) < 0.55)
        .map((item) => objectPromptPoint(item))
        .slice(0, 4),
      signal,
      onProgress,
    });
    segmenter = segmented;
    selected = selectObjectMask(
      segmented.mask,
      segmented.width,
      segmented.height,
      detectedSubject.box,
      point,
      previousMaskBox,
    );
    source = selected ? "slimsam-object-fallback" : "quality-rejected";
  }
  return {
    alpha: selected?.alpha || null,
    box: selected?.box || null,
    subject: detectedSubject,
    detections: detection?.detections || [],
    source,
    detector: detection,
    segmenter,
    point,
  };
}

export async function analyzeObjectOutlineImage(options = {}) {
  const {
    blob,
    signal,
    onProgress,
    selectedSubject = null,
  } = options;
  if (!(blob instanceof Blob) || !blob.size) throw new TypeError("实物描边需要有效图片。");
  if (selectedSubject) {
    const box = selectedSubject.box;
    if (!box || [box.xmin, box.ymin, box.xmax, box.ymax].some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
        box.xmax <= box.xmin || box.ymax <= box.ymin || typeof selectedSubject.label !== "string" || !Number.isFinite(selectedSubject.score)) {
      throw new TypeError("请选择有效的实物目标框。");
    }
  }
  throwIfAborted(signal);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const targetSize = { width: canvas.width, height: canvas.height };
  const frameBlob = await canvasToBlob(canvas, "image/jpeg", 0.9);
  const anchor = await analyzeObjectAnchor({
    canvas,
    frameBlob,
    targetSize,
    previousSubject: null,
    previousMaskBox: null,
    selectedSubject,
    signal,
    onProgress,
  });
  if (!anchor.alpha || !anchor.box || !anchor.subject) {
    throw new Error("没有找到边界清晰的实物，请选择实物更突出、遮挡更少的画面。");
  }
  const rgba = context.getImageData(0, 0, targetSize.width, targetSize.height).data;
  const cutoutCanvas = document.createElement("canvas");
  cutoutCanvas.width = targetSize.width;
  cutoutCanvas.height = targetSize.height;
  const cutoutBlob = await makeCutoutBlob(
    rgba,
    anchor.alpha,
    targetSize.width,
    targetSize.height,
    cutoutCanvas,
    cutoutCanvas.getContext("2d", { alpha: true }),
  );
  const subject = {
    label: anchor.subject.label,
    score: anchor.subject.score,
    box: normalizeSubjectBox(anchor.box, targetSize.width, targetSize.height),
  };
  onProgress?.({ progress: 100, phase: "实物 Alpha 已生成" });
  return {
    kind: "image",
    pipeline: "object-nanodet-magic-touch-slimsam",
    sourceSize: targetSize,
    subject,
    detectedSubject: anchor.subject,
    detections: anchor.detections,
    cutoutBlob,
    complete: true,
    tracking: { source: anchor.source, acceptedAnchor: true },
    modelIds: {
      detector: anchor.detector?.modelId || "NanoDet-Plus-m-320",
      segmentation: anchor.segmenter?.modelId || "MediaPipe MagicTouch 512",
      fallbackSegmentation: anchor.source.includes("slimsam") ? SLIMSAM_MODEL_ID : null,
    },
  };
}

/**
 * Browser-local object outline analysis. NanoDet proposes a concrete object,
 * MagicTouch commits the fast anchor, SlimSAM loads only when that mask fails
 * the object quality gate, and the existing ROI flow worker fills intermediate
 * 8 fps samples.
 */
export async function analyzeObjectOutlineVideo(options = {}) {
  const {
    src,
    sourceStart = 0,
    duration: requestedDuration,
    maxDimension = 360,
    flowFps = FLOW_FPS,
    anchorFps = 1 / 3.5,
    maxSamples = 360,
    selectedSubject = null,
    signal,
    onProgress,
    onSample,
  } = options;
  if (!src) throw new TypeError("实物描边分析需要视频源。");
  if (!Number.isFinite(sourceStart) || sourceStart < 0 || requestedDuration !== undefined && (!Number.isFinite(requestedDuration) || requestedDuration <= 0)) {
    throw new TypeError("请选择有效的视频源区间。");
  }
  if (selectedSubject) {
    const box = selectedSubject.box;
    if (!box || [box.xmin, box.ymin, box.xmax, box.ymax].some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
        box.xmax <= box.xmin || box.ymax <= box.ymin || typeof selectedSubject.label !== "string" || !Number.isFinite(selectedSubject.score)) {
      throw new TypeError("请选择有效的实物目标框。");
    }
  }
  // The selected box belongs to sourceStart; later anchors use its tracked mask.
  const selectedTarget = selectedSubject ? { ...selectedSubject, box: { ...selectedSubject.box } } : null;
  throwIfAborted(signal);
  const objectUrl = src instanceof Blob ? URL.createObjectURL(src) : "";
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = objectUrl || String(src);
  try {
    await ensureVideoReady(video, signal);
    if (!Number.isFinite(video.duration) || sourceStart >= video.duration || requestedDuration !== undefined && sourceStart + requestedDuration > video.duration + 0.001) {
      throw new RangeError("抠像区间超出视频源时长。");
    }
  } catch (error) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    throw error;
  }
  const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
  const targetSize = {
    width: Math.max(2, Math.round(video.videoWidth * scale)),
    height: Math.max(2, Math.round(video.videoHeight * scale)),
  };
  const duration = Math.min(video.duration - sourceStart, requestedDuration ?? video.duration - sourceStart);
  const sampleTimes = getPersonOutlineSampleTimes(duration, flowFps, maxSamples).map(time => Math.min(time, duration));
  const sourceTimes = sampleTimes.map(time => sourceStart + time);
  const anchorEvery = Math.max(1, Math.round(flowFps / Math.max(0.1, anchorFps)));
  const canvas = document.createElement("canvas");
  canvas.width = targetSize.width;
  canvas.height = targetSize.height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  const cutoutCanvas = document.createElement("canvas");
  cutoutCanvas.width = targetSize.width;
  cutoutCanvas.height = targetSize.height;
  const cutoutContext = cutoutCanvas.getContext("2d", { alpha: true });
  const samples = [];
  let sequentialFrameReader = null;
  let currentAlpha = null;
  let trackedMaskBox = null;
  let trackedMaskArea = 0;
  let trackedSubject = null;
  let flowInitialized = false;
  let lastAnchorIndex = -anchorEvery;
  let pendingSampleCommit = null;
  const startedAt = performance.now();
  const timings = {
    decodeMs: 0,
    pixelReadMs: 0,
    flowMs: 0,
    anchorMs: 0,
    cutoutEncodeMs: 0,
    callbackMs: 0,
    magicTouchAnchors: 0,
    slimSamFallbacks: 0,
  };
  try {
    onProgress?.({ progress: 1, phase: "准备 NanoDet、MagicTouch 与实物光流" });
    await getFlowWorker().ready;
    sequentialFrameReader = await createSequentialFrameReader(src, sourceTimes, signal);
    for (let index = 0; index < sampleTimes.length; index += 1) {
      throwIfAborted(signal);
      const time = sampleTimes[index];
      const decodeStartedAt = performance.now();
      const decodedCanvas = sequentialFrameReader ? await sequentialFrameReader.next() : null;
      if (!decodedCanvas) {
        await seekVideo(video, sourceTimes[index], signal);
      }
      context.fillStyle = "#000";
      context.fillRect(0, 0, targetSize.width, targetSize.height);
      context.drawImage(decodedCanvas || video, 0, 0, targetSize.width, targetSize.height);
      timings.decodeMs += performance.now() - decodeStartedAt;
      const pixelReadStartedAt = performance.now();
      let frameRgba = new Uint8ClampedArray(
        context.getImageData(0, 0, targetSize.width, targetSize.height).data,
      );
      timings.pixelReadMs += performance.now() - pixelReadStartedAt;
      let source = "flow";
      let acceptedAnchor = false;
      let detections = [];
      let flowDurationMs = 0;
      let meanMotion = null;

      if (flowInitialized && index > 0) {
        const flowStartedAt = performance.now();
        const propagated = await requestFlow("step", { rgba: frameRgba.buffer }, signal);
        timings.flowMs += performance.now() - flowStartedAt;
        frameRgba = propagated.rgba || frameRgba;
        currentAlpha = propagated.alpha;
        meanMotion = Number.isFinite(Number(propagated.meanMotion)) ? Number(propagated.meanMotion) : null;
        flowDurationMs = Number(propagated.durationMs) || 0;
        const nextBox = getAlphaBox(currentAlpha, targetSize.width, targetSize.height);
        const nextArea = nextBox
          ? (nextBox.xmax - nextBox.xmin) * (nextBox.ymax - nextBox.ymin)
          : 0;
        const areaRatio = trackedMaskArea > 0 ? nextArea / trackedMaskArea : 1;
        if (!nextBox || areaRatio < 0.35 || areaRatio > 2.8) {
          if (selectedTarget) throw new Error("选定实物已丢失，请重新选择目标或缩短片段。");
          currentAlpha = null;
          trackedMaskBox = null;
          trackedMaskArea = 0;
          source = "flow-rejected";
        } else {
          trackedMaskBox = nextBox;
          trackedMaskArea = nextArea;
        }
      }

      const needsAnchor = index === 0
        || index - lastAnchorIndex >= anchorEvery
        || !trackedMaskBox;
      if (needsAnchor) {
        lastAnchorIndex = index;
        const anchorStartedAt = performance.now();
        const frameBlob = await canvasToBlob(canvas, "image/jpeg", 0.88);
        const anchor = await analyzeObjectAnchor({
          canvas,
          frameBlob,
          targetSize,
          previousSubject: trackedSubject,
          previousMaskBox: trackedMaskBox,
          reuseTrackedSubject: index > 0 && Boolean(trackedSubject && trackedMaskBox),
          selectedSubject: selectedTarget ? index === 0 ? selectedTarget : {
            ...selectedTarget,
            box: normalizeSubjectBox(trackedMaskBox, targetSize.width, targetSize.height),
          } : null,
          signal,
          onProgress: ({ progress, phase }) => onProgress?.({
            progress: Math.max((index / sampleTimes.length) * 100, progress * 0.08),
            phase: `帧 ${index + 1}/${sampleTimes.length} · ${phase}`,
          }),
        });
        detections = anchor.detections;
        if (selectedTarget && (!anchor.alpha || !anchor.box || !anchor.subject)) {
          throw new Error("无法稳定分割选定实物，请重新选择目标或缩短片段。");
        }
        trackedSubject = anchor.subject || trackedSubject;
        if (anchor.alpha && anchor.box && anchor.subject) {
          currentAlpha = anchor.alpha;
          trackedMaskBox = anchor.box;
          trackedMaskArea = anchor.box
            ? (anchor.box.xmax - anchor.box.xmin) * (anchor.box.ymax - anchor.box.ymin)
            : 0;
          source = anchor.source;
          acceptedAnchor = true;
          if (source.includes("magic-touch")) timings.magicTouchAnchors += 1;
          if (source.includes("slimsam")) timings.slimSamFallbacks += 1;
        } else if (!currentAlpha || !trackedMaskBox) {
          currentAlpha = new Uint8ClampedArray(targetSize.width * targetSize.height);
          trackedMaskBox = null;
          trackedMaskArea = 0;
          source = "object-lost";
        }
        timings.anchorMs += performance.now() - anchorStartedAt;
      }

      currentAlpha ??= new Uint8ClampedArray(targetSize.width * targetSize.height);
      if (!flowInitialized) {
        const initialized = await requestFlow("init", {
          width: targetSize.width,
          height: targetSize.height,
          rgba: frameRgba.buffer,
          alpha: currentAlpha.slice().buffer,
        }, signal);
        frameRgba = initialized.rgba || frameRgba;
        flowInitialized = true;
      } else if (needsAnchor) {
        await requestFlow("resetAlpha", { alpha: currentAlpha.slice().buffer }, signal);
      }

      const visible = Boolean(trackedMaskBox && currentAlpha.some((value) => value >= 96));
      const subject = visible && trackedSubject ? {
        label: trackedSubject.label,
        score: Number(trackedSubject.score) || 1,
        box: normalizeSubjectBox(trackedMaskBox, targetSize.width, targetSize.height),
      } : null;
      await pendingSampleCommit;
      const cutoutStartedAt = performance.now();
      const cutoutPromise = visible
        ? makeCutoutBlob(
            frameRgba,
            currentAlpha,
            targetSize.width,
            targetSize.height,
            cutoutCanvas,
            cutoutContext,
          )
        : null;
      const sampleBase = {
        time,
        sourceSize: targetSize,
        detections,
        detectedSubject: trackedSubject,
        subject,
        tracking: {
          source,
          acceptedAnchor,
          flowDurationMs,
          meanMotion,
        },
      };
      pendingSampleCommit = (async () => {
        const cutoutBlob = await cutoutPromise;
        timings.cutoutEncodeMs += performance.now() - cutoutStartedAt;
        const sample = { ...sampleBase, cutoutBlob };
        samples.push(sample);
        const callbackStartedAt = performance.now();
        await onSample?.({ sample, index, total: sampleTimes.length, duration, sourceSize: targetSize });
        timings.callbackMs += performance.now() - callbackStartedAt;
        onProgress?.({
          progress: ((index + 1) / sampleTimes.length) * 100,
          phase: `逐帧描边 ${index + 1}/${sampleTimes.length} · ${subject ? "实物稳定" : "跳过不可靠帧"}`,
        });
      })();
    }
    await pendingSampleCommit;
    if (!samples.some((sample) => sample.subject)) {
      throw new Error("没有找到可稳定锁定的实物，请选择主体更明显的片段。");
    }
    const firstSubjectSample = samples.find((sample) => sample.subject);
    const elapsedMs = performance.now() - startedAt;
    const performanceSummary = {
      ...timings,
      elapsedMs,
      frameCount: samples.length,
      millisecondsPerFrame: elapsedMs / Math.max(1, samples.length),
      realtimeFactor: elapsedMs / Math.max(1, duration * 1000),
      decodeMode: sequentialFrameReader?.mode || "precise-seek",
      flowFps,
      anchorFps,
    };
    console.info("[Object Outline][Performance]", JSON.stringify(performanceSummary));
    return {
      kind: "video-timeline",
      pipeline: "object-nanodet-magic-touch-slimsam-flow",
      targetKind: "object",
      duration,
      sourceSize: targetSize,
      samples,
      subject: firstSubjectSample.subject,
      detections: firstSubjectSample.detections,
      complete: true,
      coverage: {
        start: samples[0]?.time || 0,
        end: samples.at(-1)?.time || 0,
        duration,
        sampleCount: samples.length,
        maxGap: samples.reduce((maximum, sample, index) => index
          ? Math.max(maximum, sample.time - samples[index - 1].time)
          : maximum, 0),
      },
      performance: performanceSummary,
      modelIds: {
        detector: "NanoDet-Plus-m-320",
        segmentation: "MediaPipe MagicTouch 512",
        fallbackSegmentation: timings.slimSamFallbacks ? SLIMSAM_MODEL_ID : null,
        propagation: "OpenCV Farneback ROI",
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      resetSlimSamWorker();
      resetFlowWorker();
    }
    throw error;
  } finally {
    await sequentialFrameReader?.dispose?.();
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export function disposePersonOutlineWorkers() {
  resetSlimSamWorker(new Error("SlimSAM Worker 已释放。"));
  resetFlowWorker(new Error("人物光流 Worker 已释放。"));
  void disposeMediaPipePersonSegmenter();
  void disposeObjectSegmentationModels();
}
