import { useCallback, useEffect, useRef, useState } from "react";

import { buildEnglishMusicPrompt, createAiMusicFileName, translateMusicDescriptionToEnglish } from "../lib/aiMusicPrompt.js";
import { repeatPcm16WavAtBestBoundary } from "../lib/aiMusicLoop.js";
import { decodeWaveform } from "../lib/media.js";
import { getModelSourcePreference } from "../lib/modelSources.js";
import { waitForModelCacheServiceWorker } from "../lib/serviceWorker.js";

export function useAiMusicGeneration({ activeLanguage, imageUrlRefs, setActiveTool, setMediaTab, setSelectedLibraryAssetId, setUserAssets }) {
  const workerRef = useRef(null);
  const activeRef = useRef(null);
  const [job, setJob] = useState({ state: "idle", progress: 0, phase: "", error: "" });

  const cancel = useCallback(() => {
    activeRef.current?.finish({ status: "cancelled" });
    workerRef.current?.terminate();
    workerRef.current = null;
    setJob({ state: "idle", progress: 0, phase: "", error: "" });
  }, []);

  useEffect(() => cancel, [cancel]);

  const generate = useCallback(async (selection, { signal, onProgress } = {}) => {
    if (activeRef.current) return { status: "busy" };
    if (signal?.aborted) return { status: "cancelled" };
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const task = { finish(result) {
      if (activeRef.current !== task) return;
      activeRef.current = null;
      signal?.removeEventListener("abort", cancel);
      resolveCompletion(result);
    } };
    activeRef.current = task;
    signal?.addEventListener("abort", cancel, { once: true });
    const failed = error => {
      if (activeRef.current !== task) return;
      workerRef.current?.terminate(); workerRef.current = null;
      const message = error?.message || String(error);
      setJob({ state: "error", progress: 0, phase: "", error: message });
      task.finish({ status: "failed", error: message });
    };
    try {
    setJob({ state: "running", progress: 0.64, phase: "translating", error: "" });
    let prompt;
    try {
      const descriptionEnglish = await translateMusicDescriptionToEnglish(selection.description || "", activeLanguage);
      prompt = buildEnglishMusicPrompt({ ...selection, descriptionEnglish });
    } catch (error) {
      failed(error);
      return completion;
    }
    if (activeRef.current !== task) return completion;
    await navigator.storage?.persist?.().catch(() => false);
    // The model cache is owned by the service worker. On a first-page visit,
    // wait until it controls the page so the initial parallel download is
    // persisted instead of falling through as an uncached worker fetch.
    await waitForModelCacheServiceWorker();
    if (activeRef.current !== task) return completion;
    const worker = workerRef.current ?? new Worker(new URL("../workers/ai-music.worker.js", import.meta.url), { type: "module" });
    const warmRuntime = Boolean(workerRef.current);
    workerRef.current = worker;
    setJob({ state: "running", progress: warmRuntime ? 0.64 : 0.01, phase: warmRuntime ? "conditioning" : "checking", error: "" });
    worker.onmessage = async ({ data }) => {
      if (activeRef.current !== task) return;
      try {
      if (data.type === "progress") {
        setJob((current) => ({ ...current, progress: data.progress, phase: data.phase }));
        try { onProgress?.({ progress: data.progress, phase: data.phase }); } catch { /* Observers do not own generation. */ }
        return;
      }
      if (data.type === "error") {
        worker.terminate();
        workerRef.current = null;
        const cacheWriteFailed = String(data.message || "").startsWith("AI_MUSIC_CACHE_WRITE_FAILED");
        setJob({
          state: "error",
          progress: 0,
          phase: "",
          error: cacheWriteFailed
            ? (String(activeLanguage).toLowerCase().startsWith("zh")
              ? `模型下载或本地缓存失败（${String(data.message).split(": ").at(-1)}），请重试。`
              : `Model download or local caching failed (${String(data.message).split(": ").at(-1)}). Try again.`)
            : data.message,
        });
        task.finish({ status: "failed", error: data.message });
        return;
      }
      if (data.type !== "complete") return;
      const requestedSeconds = Number(selection.seconds) || 30;
      const wav = requestedSeconds > 60
        ? repeatPcm16WavAtBestBoundary(data.wav, 2, 5)
        : data.wav;
      const blob = new Blob([wav], { type: "audio/wav" });
      const decoded = await decodeWaveform(blob, 96);
      if (activeRef.current !== task) return;
      const src = URL.createObjectURL(blob);
      imageUrlRefs.current.add(src);
      const asset = {
        id: crypto.randomUUID(),
        type: "audio",
        kind: "music",
        name: createAiMusicFileName(selection),
        meta: `AI music · ${decoded.duration.toFixed(1)}s`,
        src,
        previewSrc: src,
        blob,
        duration: decoded.duration,
        peaks: decoded.peaks,
        provider: "Stable Audio 3 Small · ONNX",
        generated: true,
        prompt,
      };
      setUserAssets((current) => [asset, ...current]);
      setSelectedLibraryAssetId(asset.id);
      setActiveTool("media");
      setMediaTab("mine");
      setJob({ state: "complete", progress: 1, phase: "complete", error: "" });
      task.finish({ status: "succeeded", asset: { id: asset.id, duration: asset.duration, name: asset.name } });
      } catch (error) { failed(error); }
    };
    worker.onerror = (event) => {
      failed(new Error(event.message || "Music generation failed."));
    };
    worker.postMessage({
      type: "generate",
      prompt,
      seconds: (Number(selection.seconds) || 30) / (Number(selection.seconds) > 60 ? 2 : 1),
      steps: 8,
      seed: Math.floor(Math.random() * 0x7fffffff),
      modelSourcePreference: getModelSourcePreference(activeLanguage),
    });
    } catch (error) { failed(error); }
    return completion;
  }, [activeLanguage, cancel, imageUrlRefs, setActiveTool, setMediaTab, setSelectedLibraryAssetId, setUserAssets]);

  return { job, generate, cancel };
}
