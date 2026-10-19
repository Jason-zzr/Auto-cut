import { REMASTER_DRUNET_MODEL, REMASTER_DRUNET_MODEL_URL } from "../config/models.js";

export const REMASTER_DRUNET_MODEL_LABEL = REMASTER_DRUNET_MODEL.label;
export { REMASTER_DRUNET_MODEL_URL };

let worker = null;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/remaster.worker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event) => {
    const message = event.data ?? {};
    const request = pending.get(message.requestId);
    if (!request) { message.result?.bitmap?.close?.(); return; }
    if (message.type === "progress") { request.onProgress?.(message); return; }
    pending.delete(message.requestId);
    request.signal?.removeEventListener("abort", request.abort);
    if (message.type === "result") request.resolve(message.result);
    else request.reject(new Error(message.error || "视频增强失败"));
  });
  worker.addEventListener("error", (event) => {
    const error = new Error(event.message || "视频增强 Worker 运行失败");
    pending.forEach((request) => request.reject(error)); pending.clear();
    worker?.terminate(); worker = null;
  });
  return worker;
}

export function enhanceRemasterFrame({ bitmap, maxLongEdge = 960, strength = 1, outputType = "blob", sequenceId = "", allowResidualReuse = false, reuseThreshold = 0.012, onProgress, signal }) {
  if (!bitmap) return Promise.reject(new Error("没有可增强的画面"));
  const requestId = `remaster-${crypto.randomUUID?.() ?? Date.now()}`;
  return new Promise((resolve, reject) => {
    const activeWorker = getWorker();
    const abort = () => {
      pending.delete(requestId);
      bitmap.close?.();
      activeWorker.postMessage({ type: "cancel", requestId });
      const error = new Error("视频增强已取消"); error.name = "AbortError"; reject(error);
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    pending.set(requestId, { resolve, reject, onProgress, signal, abort });
    activeWorker.postMessage({ type: "enhance", requestId, bitmap, maxLongEdge, strength, outputType, sequenceId, allowResidualReuse, reuseThreshold }, [bitmap]);
  });
}

export async function captureRemasterSource({ type, src, video }) {
  if (type === "video") {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      throw new Error("当前视频帧尚未准备好，请稍后重试");
    }
    return createImageBitmap(video);
  }
  const response = await fetch(src);
  if (!response.ok) throw new Error(`读取画面失败（HTTP ${response.status}）`);
  return createImageBitmap(await response.blob());
}

export function disposeRemasterWorker() {
  worker?.terminate(); worker = null;
  pending.forEach((request) => request.reject(new Error("视频增强 Worker 已关闭")));
  pending.clear();
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposeRemasterWorker);
}

export const REMASTER_MODE_STRENGTH = { light: 0.38, balanced: 0.68, strong: 1 };

export function estimateNoise(bitmap) {
  const width = Math.min(320, bitmap.width);
  const height = Math.max(2, Math.round(bitmap.height * width / Math.max(1, bitmap.width)));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  let residual = 0;
  let samples = 0;
  const luma = (index) => data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const index = (y * width + x) * 4;
      const center = luma(index);
      const average = (luma(index - 4) + luma(index + 4) + luma(index - width * 4) + luma(index + width * 4)) / 4;
      residual += Math.min(32, Math.abs(center - average));
      samples += 1;
    }
  }
  const score = Math.max(0, Math.min(1, residual / Math.max(1, samples) / 13));
  return { score, strength: Math.max(0.42, Math.min(0.92, 0.42 + score * 0.5)) };
}
