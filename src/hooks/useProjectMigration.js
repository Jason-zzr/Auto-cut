import { useEffect, useRef, useState } from "react";
import { z } from "zod";

const active = status => ["queued", "running", "cancel_requested"].includes(status);
const STORAGE_KEY = "autocut.project-migration";
const text = z.string().min(1).max(256);
const requestRecord = z.strictObject({ action: z.enum(["start", "retry", "cancel"]), path: z.string().max(2048), key: text,
  body: z.record(z.string(), z.string().max(256)) });
const storedRecord = z.strictObject({
  operation: z.strictObject({ kind: z.enum(["export", "import"]), name: text, projectId: text.optional(), taskId: text.nullable(), startRequest: requestRecord }),
  pending: requestRecord.nullable() }).superRefine((value, context) => {
  const op = value.operation;
  if (op.startRequest.action !== "start" || op.startRequest.body.name !== op.name || (op.kind === "export" && !op.projectId)) context.addIssue({ code: "custom", message: "Invalid migration identity." });
  for (const request of [op.startRequest, value.pending].filter(Boolean)) {
    const start = request.action === "start", exporting = op.kind === "export";
    const path = start ? exporting ? `/api/v1/projects/${encodeURIComponent(op.projectId)}/migration-exports` : "/api/v1/project-imports"
      : `/api/v1/tasks/${encodeURIComponent(op.taskId)}/${request.action === "retry" ? "retries" : "cancel-requests"}`;
    const fields = start ? exporting ? { editorSessionId: text, savePointId: text, selectionId: text, name: text } : { selectionId: text, targetSelectionId: text, name: text }
      : { ...(exporting ? { projectId: z.literal(op.projectId), editorSessionId: text } : request.action === "retry" ? { selectionId: text } : {}),
        ...(request.action === "retry" ? { expectedAttemptId: text } : { reason: z.literal("user") }) };
    if (request.path !== path || (!start && !op.taskId) || !z.strictObject(fields).safeParse(request.body).success) context.addIssue({ code: "custom", message: "Invalid migration request." });
  }
});

function remembered() {
  try {
    const bytes = sessionStorage.getItem(STORAGE_KEY);
    return bytes && bytes.length <= 16384 ? storedRecord.parse(JSON.parse(bytes)) : null;
  } catch { return null; }
}

export function useProjectMigration({ hostSession, getExportContext }) {
  const latest = useRef({ hostSession, getExportContext });
  latest.current = { hostSession, getExportContext };
  const restored = useRef(undefined);
  if (restored.current === undefined) restored.current = remembered();
  const operation = useRef(restored.current?.operation ?? null), pending = useRef(restored.current?.pending ?? null), working = useRef(false);
  const [state, setState] = useState({ kind: operation.current?.kind ?? null, name: operation.current?.name ?? "", task: null, busy: false,
    pending: Boolean(pending.current), needsReconnect: Boolean(restored.current), error: "" });
  const remember = () => {
    if (!operation.current) return;
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storedRecord.parse({ operation: operation.current, pending: pending.current }))); }
    catch { /* The current page still retains its original request in memory. */ }
  };
  const trusted = event => { if (!event?.isTrusted) throw new Error("请使用项目迁移窗口中的按钮操作。"); };
  const select = async purpose => latest.current.hostSession.request("/api/v1/file-selections", { purpose, multiple: false }, undefined,
    { signal: AbortSignal.timeout(130_000) });
  const refresh = async () => {
    if (!operation.current?.taskId) return;
    const task = await latest.current.hostSession.request(`/api/v1/tasks/${encodeURIComponent(operation.current.taskId)}`, undefined, undefined,
      { signal: AbortSignal.timeout(300_000) });
    setState(old => ({ ...old, task, error: task.error?.message || "" }));
    return task;
  };
  const sendPending = async () => {
    const request = pending.current;
    const result = await latest.current.hostSession.request(request.path, request.body, request.key, { signal: AbortSignal.timeout(300_000) });
    if (request.action === "start") operation.current.taskId = result.taskId;
    pending.current = null;
    remember();
    setState(old => ({ ...old, pending: false }));
    await refresh();
  };
  const perform = async (action) => {
    if (working.current) return { outcome: "blocked", error: "项目迁移正在处理。" };
    working.current = true; setState(old => ({ ...old, busy: true, error: "" }));
    try {
      await action();
      return { outcome: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "项目迁移操作失败。";
      setState(old => ({ ...old, error: message, pending: Boolean(pending.current) }));
      return { outcome: "failed", error: message };
    }
    finally { remember(); working.current = false; setState(old => ({ ...old, busy: false })); }
  };
  const startOperation = (kind, name) => perform(async () => {
    if (state.needsReconnect || pending.current || active(state.task?.status)) throw new Error("请先处理当前迁移任务。");
    if (!["export", "import"].includes(kind) || !name.trim()) throw new Error("请输入项目包或新目录名称。");
    let body, path;
    if (kind === "export") {
      const initial = await latest.current.getExportContext();
      const selection = await select("migration-export");
      const context = await latest.current.getExportContext();
      if (context.projectId !== initial.projectId) throw new Error("当前项目已切换，请重新导出。");
      body = { editorSessionId: context.editorSessionId, savePointId: context.savePointId, selectionId: selection.selectionId, name };
      path = `/api/v1/projects/${encodeURIComponent(context.projectId)}/migration-exports`;
      operation.current = { kind, projectId: context.projectId, taskId: null };
    } else {
      const source = await select("project-import"), target = await select("project-create");
      body = { selectionId: source.selectionId, targetSelectionId: target.selectionId, name };
      path = "/api/v1/project-imports"; operation.current = { kind, taskId: null };
    }
    pending.current = { action: "start", path, body, key: crypto.randomUUID() };
    operation.current.name = name; operation.current.startRequest = structuredClone(pending.current); remember();
    setState(old => ({ ...old, kind, name, task: null, pending: true, needsReconnect: false }));
    await sendPending();
  });
  const start = async (event, kind, name) => { trusted(event); return startOperation(kind, name); };
  const controlOperation = action => perform(async () => {
    if (action === "recover") {
      const current = operation.current;
      if (!current) throw new Error("没有可恢复的迁移记录。");
      const request = structuredClone(current.startRequest);
      if (current.kind === "export") {
        const context = await latest.current.getExportContext(false);
        if (context.projectId !== current.projectId) throw new Error("请先打开原导出项目。");
        request.body.editorSessionId = context.editorSessionId;
        request.body.selectionId = (await select("migration-export")).selectionId;
      } else {
        request.body.selectionId = (await select("project-import")).selectionId;
        request.body.targetSelectionId = (await select("project-create")).selectionId;
      }
      const result = await latest.current.hostSession.request(request.path, request.body, request.key, { signal: AbortSignal.timeout(300_000) });
      current.taskId = result.taskId; current.startRequest = request;
      if (pending.current?.action === "start") pending.current = null;
      remember(); setState(old => ({ ...old, needsReconnect: false, pending: Boolean(pending.current) }));
      await refresh(); return;
    }
    if (state.needsReconnect) throw new Error("请先恢复上次迁移任务。");
    if (action === "repeat") {
      if (!pending.current) throw new Error("没有待确认的迁移请求。");
      remember(); await sendPending(); return;
    }
    if (action === "reselect") {
      const request = pending.current, current = operation.current;
      if (!request || !current) throw new Error("没有待确认的迁移请求。");
      if (current.kind === "export") {
        const context = await latest.current.getExportContext(false);
        if (context.projectId !== current.projectId) throw new Error("请先打开原导出项目。");
        request.body.editorSessionId = context.editorSessionId;
        if (request.action === "start") request.body.selectionId = (await select("migration-export")).selectionId;
      } else if (request.action !== "cancel") {
        request.body.selectionId = (await select("project-import")).selectionId;
        if (request.action === "start") request.body.targetSelectionId = (await select("project-create")).selectionId;
      }
      remember(); await sendPending(); return;
    }
    if (pending.current) throw new Error("请先重试结果未知的请求。");
    if (action === "refresh") { await refresh(); return; }
    const current = operation.current;
    if (!current?.taskId) throw new Error("没有可操作的迁移任务。");
    const task = await refresh();
    let body;
    if (current.kind === "export") {
      const context = await latest.current.getExportContext(false);
      if (context.projectId !== current.projectId) throw new Error("请先打开此导出任务的原项目。");
      body = { projectId: context.projectId, editorSessionId: context.editorSessionId };
    } else body = action === "retry" ? { selectionId: (await select("project-import")).selectionId } : {};
    if (action === "retry") body.expectedAttemptId = task.attemptId;
    else if (action === "cancel") body.reason = "user";
    else throw new Error("未知的迁移操作。");
    pending.current = { action, path: `/api/v1/tasks/${encodeURIComponent(current.taskId)}/${action === "retry" ? "retries" : "cancel-requests"}`,
      body, key: crypto.randomUUID() };
    remember(); setState(old => ({ ...old, pending: true })); await sendPending();
  });
  const control = async (event, action) => { trusted(event); return controlOperation(action); };
  useEffect(() => {
    const taskId = restored.current?.operation.taskId;
    if (!hostSession || !taskId) return undefined;
    let disposed = false;
    const timer = setTimeout(() => {
      void hostSession.request(`/api/v1/tasks/${encodeURIComponent(taskId)}`).then(task => {
        if (!disposed && operation.current?.taskId === taskId) setState(old => ({ ...old, task, needsReconnect: false, error: task.error?.message || "" }));
      }).catch(() => { /* Re-selection restores page authorization after a host restart. */ });
    }, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [hostSession]);
  useEffect(() => {
    if (!hostSession || !operation.current?.taskId || !active(state.task?.status)) return undefined;
    let disposed = false, timer;
    const poll = async () => {
      try {
        const task = await hostSession.request(`/api/v1/tasks/${encodeURIComponent(operation.current.taskId)}`);
        if (disposed) return;
        setState(old => ({ ...old, task, error: task.error?.message || "" }));
        if (active(task.status)) timer = setTimeout(poll, 1000);
      } catch (error) { if (!disposed) setState(old => ({ ...old, error: error.message })); }
    };
    timer = setTimeout(poll, 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [hostSession, state.task?.taskId, state.task?.status]);
  return { ...state, start, control, startAgent: startOperation, controlAgent: controlOperation,
    inFlight: working.current || (!state.needsReconnect && (Boolean(pending.current) || active(state.task?.status))) };
}
