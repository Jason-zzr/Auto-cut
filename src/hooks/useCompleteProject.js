import { useEffect, useRef, useState } from "react";
import { createProjectSaveQueue } from "../lib/projectSaveQueue.js";
import { waitForHostMediaController } from "../lib/serviceWorker.js";
import { trashSelection } from "../lib/projectTrash.js";
import { useProjectMigration } from "./useProjectMigration.js";
import { useMaterialAnalysis } from "./useMaterialAnalysis.js";
import { useScriptReview } from "./useScriptReview.js";
import { projectMediaUrl } from "../lib/projectSnapshot.js";

const PROJECT_BINDING_KEY = "autocut.project-binding";

export function useCompleteProject({ hostSession, captureCompleteProject, prepareCompleteProject, handleNewProject, isEditorBusy, notify }) {
  const [state, setState] = useState({ status: "unbound", name: "", pending: 0, lastSaved: null, error: "" });
  const binding = useRef(null);
  const creating = useRef(false);
  const latest = useRef({ captureCompleteProject, prepareCompleteProject, handleNewProject, isEditorBusy, notify });
  latest.current = { captureCompleteProject, prepareCompleteProject, handleNewProject, isEditorBusy, notify };
  const operationVersion = useRef(0);
  const identities = useRef({ blobs: new WeakMap(), next: 0 });
  const lastSignature = useRef("");
  const observedSignature = useRef("");
  const captureTimer = useRef(null);
  const pendingCapture = useRef(false);
  const pendingStorage = useRef(null);
  const ensureOperation = (version) => {
    if (version !== operationVersion.current) throw new Error("项目操作已结束。");
  };
  const remember = (current) => {
    try {
      sessionStorage.setItem(PROJECT_BINDING_KEY, JSON.stringify({ projectId: current.project.projectId,
        instanceId: hostSession.getSnapshot().session.instanceId }));
    } catch { /* Saving the project does not depend on browser storage availability. */ }
  };
  const signature = (captured) => {
    const content = { ...captured };
    for (const key of ["currentTime", "selectedTrack", "selectedSegmentId", "selectedVisualSegmentId", "selectedVisualOverlayId", "selectedStickerSegmentId", "selectedAudioSegmentId"]) delete content[key];
    if (content.visualSegments?.length) {
      for (const key of ["imageSrc", "imageName", "imageMeta", "visualType"]) delete content[key];
    }
    if (content.audioSegments?.length) {
      for (const key of ["audioBlob", "audioUrl", "audioDuration"]) delete content[key];
    }
    return JSON.stringify(content, (_key, value) => {
      if (!(value instanceof Blob)) return value;
      if (!identities.current.blobs.has(value)) identities.current.blobs.set(value, ++identities.current.next);
      return { blobIdentity: identities.current.blobs.get(value) };
    });
  };

  const acquire = async (current) => {
    const pageSessionId = hostSession.getSnapshot().session?.pageSessionId;
    current.lease = await hostSession.request(`/api/v1/projects/${encodeURIComponent(current.project.projectId)}/editor-sessions`, { pageSessionId, mode: "write" });
  };
  const installQueue = (current) => {
    current.queue = createProjectSaveQueue({ hostSession, projectId: current.project.projectId,
      editorSequence: current.project.editorSequence ?? -1,
      getEditorSessionId: () => {
        if (!current.lease || Date.parse(current.lease.expiresAt) <= Date.now()) throw new Error("编辑会话已过期，请重试保存。");
        return current.lease.editorSessionId;
      } });
    current.unsubscribe = current.queue.subscribe(() => {
      const queued = current.queue.getSnapshot();
      if (queued.lastSaved) remember(current);
      setState(previous => ({ ...previous, ...queued, name: current.project.name,
        status: pendingCapture.current && queued.status !== "error" ? "dirty" : queued.status }));
    });
  };

  const save = async () => {
    if (!hostSession || creating.current) return;
    const version = ++operationVersion.current;
    creating.current = true;
    setState(previous => ({ ...previous, status: "preparing", error: "" }));
    try {
      let current = binding.current;
      if (!current) {
        const name = window.prompt("完整项目名称", "Auto-cut 项目");
        if (name === null) { setState(previous => ({ ...previous, status: "unbound" })); return; }
        const selection = await hostSession.request("/api/v1/file-selections", { purpose: "project-create", multiple: false }, undefined,
          { signal: AbortSignal.timeout(130_000) });
        const project = await hostSession.request("/api/v1/projects", { selectionId: selection.selectionId, name });
        ensureOperation(version);
        current = { project, lease: null, queue: null, unsubscribe: null };
        binding.current = current;
      }
      if (!current.lease || Date.parse(current.lease.expiresAt) <= Date.now()) await acquire(current);
      ensureOperation(version);
      if (!current.queue) installQueue(current);
      const captured = latest.current.captureCompleteProject();
      const nextSignature = signature(captured);
      if (nextSignature !== lastSignature.current) {
        current.queue.enqueue(captured);
        lastSignature.current = nextSignature;
      }
      clearTimeout(captureTimer.current); pendingCapture.current = false; observedSignature.current = nextSignature;
      current.queue.retry();
      setState({ ...current.queue.getSnapshot(), name: current.project.name });
    } catch (error) {
      if (version !== operationVersion.current) return;
      const message = error instanceof Error ? error.message : "完整项目保存失败。";
      setState(previous => ({ ...previous, status: "error", error: message }));
      latest.current.notify(message);
    } finally { if (version === operationVersion.current) creating.current = false; }
  };

  const open = async (resumeProjectId = null) => {
    if (!hostSession || creating.current) return;
    const previous = binding.current;
    if (analysis.running || analysis.unresolved || analysis.pendingSave || migration.inFlight || pendingStorage.current || pendingCapture.current || previous?.queue?.busy() || latest.current.isEditorBusy?.()) {
      latest.current.notify("请等待当前编辑和保存完成后再打开项目。"); return;
    }
    if (!resumeProjectId && !window.confirm("打开完整项目将替换当前时间线，是否继续？")) return;
    const originalSignature = signature(latest.current.captureCompleteProject());
    const version = ++operationVersion.current;
    creating.current = true;
    setState(old => ({ ...old, status: "preparing", error: "" }));
    let candidate;
    try {
      let project;
      if (resumeProjectId) project = await hostSession.request(`/api/v1/projects/${encodeURIComponent(resumeProjectId)}`);
      else {
        const selection = await hostSession.request("/api/v1/file-selections", { purpose: "project-open", multiple: false }, undefined,
          { signal: AbortSignal.timeout(130_000) });
        try {
          project = await hostSession.request("/api/v1/projects/open", { selectionId: selection.selectionId });
        } catch (error) {
          if (!["PROJECT_INVALID", "STORAGE_IO_FAILED", "REFERENCE_INVALID", "INVALID_ARGUMENT"].includes(error?.code)) throw error;
          const report = await hostSession.request("/api/v1/projects/recovery-options", { selectionId: selection.selectionId });
          if (report.status !== "previous_available") throw new Error(report.status === "no_valid_previous"
            ? "当前及上一保存点均不可用，项目文件已保留。" : error.message, { cause: error });
          ensureOperation(version);
          if (signature(latest.current.captureCompleteProject()) !== originalSignature || latest.current.isEditorBusy?.()) {
            throw new Error("当前内容发生变化，请先保存再执行项目恢复。", { cause: error });
          }
          if (!window.confirm(`当前保存点损坏。是否恢复到上一完整保存点${report.previousEditorSequence === null ? "（不含编辑快照）" : `（编辑序号 ${report.previousEditorSequence}）`}？\n后续编辑和未提交保存不会继续应用，完整产物和损坏文件会保留。`)) {
            throw new Error("已取消回退，项目文件保持原样。", { cause: error });
          }
          const choice = { currentSavePointId: report.currentSavePointId, currentCommitSequence: report.currentCommitSequence,
            currentCommitSha256: report.currentCommitSha256, previousSavePointId: report.previousSavePointId };
          const signal = AbortSignal.timeout(300_000);
          const receipt = await hostSession.request("/api/v1/projects/recoveries", { selectionId: selection.selectionId,
            projectId: report.projectId, choice }, crypto.randomUUID(), { signal });
          for (;;) {
            ensureOperation(version);
            const saved = await hostSession.request(`/api/v1/saves/${encodeURIComponent(receipt.saveId)}`, undefined, undefined, { signal });
            if (saved.status === "failed") throw new Error(saved.error?.message || "项目回退未完成，原文件已保留。", { cause: error });
            if (saved.status === "succeeded") {
              if (!saved.savePointId) throw new Error("回退回执缺少保存点。", { cause: error });
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          project = await hostSession.request(`/api/v1/projects/${encodeURIComponent(receipt.projectId)}`);
        }
      }
      ensureOperation(version);
      candidate = { project, lease: null, queue: null, unsubscribe: null };
      await acquire(candidate);
      await waitForHostMediaController();
      const data = await hostSession.request(`/api/v1/projects/${encodeURIComponent(project.projectId)}`);
      candidate.project = data;
      const prepared = data.editorSnapshot ? await latest.current.prepareCompleteProject(data.editorSnapshot, project.projectId) : null;
      ensureOperation(version);
      if (signature(latest.current.captureCompleteProject()) !== originalSignature || latest.current.isEditorBusy?.()) {
        throw new Error("打开期间当前内容发生变化，已保留当前时间线。请保存后重新打开。");
      }
      await acquire(candidate);
      ensureOperation(version);
      if (previous?.lease && previous.lease.editorSessionId !== candidate.lease.editorSessionId) {
        await hostSession.request(`/api/v1/editor-sessions/${encodeURIComponent(previous.lease.editorSessionId)}`, undefined, undefined, { method: "DELETE" });
        previous.lease = null;
      }
      ensureOperation(version);
      const restoredSignature = prepared ? signature(prepared.captured) : null;
      installQueue(candidate);
      previous?.unsubscribe?.(); previous?.queue?.close();
      clearTimeout(captureTimer.current); pendingCapture.current = false;
      binding.current = candidate;
      lastSignature.current = restoredSignature; observedSignature.current = restoredSignature;
      if (prepared) prepared.apply();
      else latest.current.handleNewProject({ confirmed: true, complete: true });
      remember(candidate);
      setState({ ...candidate.queue.getSnapshot(), status: "opened", name: project.name });
      latest.current.notify("完整项目已打开。");
    } catch (error) {
      if (candidate?.lease && candidate.lease.editorSessionId !== previous?.lease?.editorSessionId) {
        await hostSession.request(`/api/v1/editor-sessions/${encodeURIComponent(candidate.lease.editorSessionId)}`, undefined, undefined, { method: "DELETE" }).catch(() => {});
      }
      if (version !== operationVersion.current) return;
      const message = error?.code === "PROJECT_ID_CONFLICT" ? "请先在文件菜单关闭正在编辑的项目副本，再打开所选目录。"
        : error instanceof Error ? error.message : "打开完整项目失败。";
      setState(old => ({ ...old, status: "error", error: message })); latest.current.notify(message);
    } finally { if (version === operationVersion.current) creating.current = false; }
  };

  const resetProject = async (closeCurrent = false) => {
    if (creating.current) return;
    const current = binding.current;
    if (closeCurrent && !current) return;
    if (analysis.running || analysis.unresolved || analysis.pendingSave || migration.inFlight || pendingStorage.current || pendingCapture.current || current?.queue?.busy() || latest.current.isEditorBusy?.()) {
      latest.current.notify(closeCurrent ? "请等待当前编辑和保存完成后再关闭项目。" : "请等待当前编辑和保存完成后再新建项目。"); return;
    }
    if (!window.confirm(closeCurrent ? "关闭当前完整项目？已保存的项目文件会保留，当前时间线将清空。" : "新建项目将清空当前时间线，是否继续？")) return;
    const originalSignature = signature(latest.current.captureCompleteProject());
    const version = ++operationVersion.current;
    creating.current = true;
    try {
      if (current?.lease) {
        await hostSession.request(`/api/v1/editor-sessions/${encodeURIComponent(current.lease.editorSessionId)}`, undefined, undefined, { method: "DELETE" });
        current.lease = null;
      }
      ensureOperation(version);
      if (signature(latest.current.captureCompleteProject()) !== originalSignature || latest.current.isEditorBusy?.()) {
        throw new Error("当前内容发生变化，已保留时间线。请保存后重试。");
      }
      current?.unsubscribe?.(); current?.queue?.close(); binding.current = null;
      clearTimeout(captureTimer.current); pendingCapture.current = false;
      lastSignature.current = ""; observedSignature.current = "";
      try { sessionStorage.removeItem(PROJECT_BINDING_KEY); } catch { /* Memory-only mode. */ }
      latest.current.handleNewProject({ confirmed: true, complete: true, ...(closeCurrent ? { closed: true } : {}) });
      setState({ status: "unbound", name: "", pending: 0, lastSaved: null, error: "" });
    } catch (error) {
      if (version === operationVersion.current) {
        setState(old => ({ ...old, status: "error", error: error.message })); latest.current.notify(error.message);
      }
    } finally { if (version === operationVersion.current) creating.current = false; }
  };
  latest.current.open = open;

  const listStorage = async (collection, cursor) => {
    const current = binding.current;
    if (!current || !["assets", "trash"].includes(collection)) throw new Error("请先打开完整项目。");
    return hostSession.request(`/api/v1/projects/${encodeURIComponent(current.project.projectId)}/${collection}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      undefined, undefined, { signal: AbortSignal.timeout(300_000) });
  };
  const changeStorage = async (event, action, entries = []) => {
    if (!event?.isTrusted) throw new Error("请使用项目素材窗口中的按钮操作。");
    const current = binding.current;
    if (!current || creating.current || pendingCapture.current || current.queue?.busy() || latest.current.isEditorBusy?.()) {
      throw new Error("请等待当前编辑和保存完成后再操作项目素材。");
    }
    if (action !== "retry" && pendingStorage.current) throw new Error("上次操作结果尚未确认，请先重试。");
    if (action === "retry" && !pendingStorage.current) return;
    if (!["delete", "restore", "empty", "collect", "retry"].includes(action)) throw new Error("未知的项目素材操作。");
    if (!["retry", "collect"].includes(action) && (!entries.length || (action !== "empty" && entries.length !== 1) || entries.length > 1000)) throw new Error("请选择有效的项目素材。");
    if (action === "delete" && !window.confirm(`将“${entries[0].name}”移入项目回收站？`)) return;
    if (action === "empty" && !window.confirm(`清空选中的 ${entries.length} 项？\n${entries.map(item => item.name).join("\n")}\n仍被项目引用的文件会继续保留；文件释放后无法恢复。`)) return;
    creating.current = true;
    setState(old => ({ ...old, storageBusy: true, storageError: "" }));
    try {
      if (!current.lease || Date.parse(current.lease.expiresAt) <= Date.now()) await acquire(current);
      const projectId = current.project.projectId, base = `/api/v1/projects/${encodeURIComponent(projectId)}`;
      if (!pendingStorage.current) {
        const pending = { projectId, key: crypto.randomUUID(), action, body: {}, options: {}, path: "", saveId: null };
        if (action === "collect") {
          pending.path = `${base}/trash/collection-retries`;
        } else if (action === "delete") {
          pending.path = `${base}/assets/${encodeURIComponent(entries[0].assetId)}`;
          pending.options = { method: "DELETE", revision: entries[0].revision };
        } else if (action === "restore") {
          pending.path = `${base}/trash/${encodeURIComponent(entries[0].tombstoneId)}/restore`;
          pending.body = { revision: entries[0].revision };
        } else {
          const selection = await trashSelection(projectId, entries);
          const confirmation = await hostSession.request("/api/v1/confirmation-challenges", { action: "trash.empty", subjectId: projectId,
            editorSessionId: current.lease.editorSessionId, ...selection });
          pending.path = `${base}/trash/empty`;
          pending.body = { ...selection, confirmationId: confirmation.confirmationId };
        }
        pendingStorage.current = pending;
      }
      const pending = pendingStorage.current;
      if (pending.projectId !== projectId) throw new Error("待确认操作属于另一个项目，请重新打开原项目。");
      const signal = AbortSignal.timeout(300_000);
      if (!pending.saveId) {
        const receipt = await hostSession.request(pending.path, { ...pending.body, editorSessionId: current.lease.editorSessionId }, pending.key,
          { ...pending.options, signal });
        if (pending.action === "collect") {
          pendingStorage.current = null;
          latest.current.notify(`回收检查完成：释放 ${receipt.removed} 项，${receipt.pending} 项待重试。`);
          return;
        }
        pending.saveId = receipt.saveId;
      }
      for (;;) {
        const saved = await hostSession.request(`/api/v1/saves/${encodeURIComponent(pending.saveId)}`, undefined, undefined, { signal });
        if (saved.status === "failed") {
          pendingStorage.current = null;
          throw new Error(saved.error?.message || "项目素材操作保存失败。");
        }
        if (saved.status === "succeeded") { pendingStorage.current = null; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      latest.current.notify("项目素材操作已保存。");
    } catch (error) {
      if (["REVISION_CONFLICT", "REFERENCE_STALE", "USER_CONFIRMATION_REQUIRED", "ASSET_NOT_FOUND", "INVALID_ARGUMENT"].includes(error?.code)) pendingStorage.current = null;
      setState(old => ({ ...old, storageError: error.message }));
      throw error;
    } finally {
      creating.current = false;
      setState(old => ({ ...old, storageBusy: false, storagePending: Boolean(pendingStorage.current) }));
      if (binding.current === current) {
        try {
          const captured = latest.current.captureCompleteProject(), next = signature(captured);
          if (next !== lastSignature.current) {
            current.queue.enqueue(captured); lastSignature.current = next; observedSignature.current = next;
          }
        } catch (error) { pendingCapture.current = true; latest.current.notify(error.message); }
      }
    }
  };

  useEffect(() => {
    const current = binding.current;
    if (!current?.queue || creating.current) return undefined;
    try {
      const captured = captureCompleteProject();
      const nextSignature = signature(captured);
      if (nextSignature === observedSignature.current) return undefined;
      observedSignature.current = nextSignature;
      clearTimeout(captureTimer.current);
      pendingCapture.current = nextSignature !== lastSignature.current;
      if (!pendingCapture.current) return undefined;
      setState(previous => ({ ...previous, status: previous.status === "error" ? "error" : "dirty" }));
      captureTimer.current = setTimeout(() => {
        pendingCapture.current = false;
        current.queue.enqueue(captured);
        lastSignature.current = nextSignature;
      }, 750);
    } catch (error) {
      pendingCapture.current = true;
      setState(previous => previous.error === error.message ? previous : { ...previous, status: "error", error: error.message });
    }
    return undefined;
  }, [captureCompleteProject]);

  useEffect(() => {
    if (!hostSession) return undefined;
    let disposed = false;
    let timer;
    const operations = operationVersion;
    const resumeTimer = setTimeout(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(PROJECT_BINDING_KEY) || "null");
        if (!saved) return;
        if (typeof saved.projectId !== "string" || saved.instanceId !== hostSession.getSnapshot().session?.instanceId) {
          sessionStorage.removeItem(PROJECT_BINDING_KEY); return;
        }
        if (!binding.current && !creating.current) void latest.current.open(saved.projectId);
      } catch { /* No valid remembered project. */ }
    }, 0);
    const renew = async () => {
      if (disposed || hostSession.getSnapshot().connection === "draining") return;
      const current = binding.current;
      if (current?.lease) {
        try {
          current.lease = await hostSession.request(`/api/v1/editor-sessions/${encodeURIComponent(current.lease.editorSessionId)}/renew`, { revision: current.lease.revision });
        } catch (error) {
          current.lease = null;
          if (!disposed && binding.current === current && hostSession.getSnapshot().connection !== "draining") {
            setState(previous => ({ ...previous, status: "error", error: error.message }));
          }
        }
      }
      if (!disposed && hostSession.getSnapshot().connection !== "draining") timer = setTimeout(renew, 20_000);
    };
    timer = setTimeout(renew, 20_000);
    const preventLoss = (event) => {
      if (binding.current && (pendingStorage.current || pendingCapture.current || binding.current.queue?.busy())) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => {
      disposed = true; operations.current++; creating.current = false;
      clearTimeout(timer); clearTimeout(resumeTimer); clearTimeout(captureTimer.current); window.removeEventListener("beforeunload", preventLoss);
      const current = binding.current;
      current?.unsubscribe?.(); current?.queue?.close();
      binding.current = null;
    };
  }, [hostSession]);

  const migration = useProjectMigration({ hostSession, getExportContext: async (requireSaved = true) => {
    const current = binding.current;
    if (!current) throw new Error("请先保存或打开完整项目。");
    if (requireSaved && (creating.current || pendingStorage.current || pendingCapture.current || current.queue?.busy() || latest.current.isEditorBusy?.() ||
      signature(latest.current.captureCompleteProject()) !== lastSignature.current)) throw new Error("请先保存当前编辑，再导出完整项目。");
    if (!current.lease || Date.parse(current.lease.expiresAt) <= Date.now()) await acquire(current);
    const project = await hostSession.request(`/api/v1/projects/${encodeURIComponent(current.project.projectId)}`);
    if (binding.current !== current || !project.currentSavePointId || project.blocked || (requireSaved && project.pending)) throw new Error("项目状态已变化，请保存后重试。");
    return { projectId: project.projectId, editorSessionId: current.lease.editorSessionId, savePointId: project.currentSavePointId };
  } });
  const getAnalysisContext = async () => {
    const current = binding.current;
    if (!current || creating.current) throw new Error("请先打开或保存完整项目，再分析素材。");
    if (!current.lease || Date.parse(current.lease.expiresAt) <= Date.now()) await acquire(current);
    if (binding.current !== current) throw new Error("当前项目已切换。");
    return { projectId: current.project.projectId, editorSessionId: current.lease.editorSessionId };
  };
  const analysis = useMaterialAnalysis({ hostSession, isEditorBusy: () => latest.current.isEditorBusy?.(), getContext: getAnalysisContext });
  const scriptReview = useScriptReview({ hostSession, getContext: getAnalysisContext });
  const execution = {
    context: getAnalysisContext,
    async request(path, body, key) {
      const context = await getAnalysisContext();
      return hostSession.request(`/api/v1/projects/${encodeURIComponent(context.projectId)}/${path}`,
        body === undefined ? undefined : { ...body, editorSessionId: context.editorSessionId }, key, { signal: AbortSignal.timeout(300_000) });
    },
    async registerMedia(asset) {
      await getAnalysisContext();
      const current = binding.current;
      if (!current?.queue) throw new Error("请先保存完整项目。");
      const source = asset.projectMedia?.projectId === current.project.projectId && asset.projectMedia.bindings?.blob
        ? projectMediaUrl(current.project.projectId, asset.projectMedia.bindings.blob) : asset.blob || asset.src;
      const ref = await current.queue.registerMedia(source, asset.name, "execution-result", AbortSignal.timeout(300_000));
      if (binding.current !== current) throw new Error("当前项目已切换。");
      return ref;
    },
  };
  return hostSession ? { ...state, migration, analysis, scriptReview, execution, storagePending: Boolean(pendingStorage.current), save, open, listStorage, changeStorage, projectId: binding.current?.project.projectId,
    newProject: () => resetProject(), closeProject: () => resetProject(true),
    busy: () => scriptReview.saving || analysis.running || analysis.unresolved || Boolean(analysis.pendingSave) || migration.inFlight || creating.current || Boolean(pendingStorage.current) || pendingCapture.current || Boolean(binding.current?.queue?.busy()) } : null;
}
