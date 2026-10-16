import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HostError, type PageSession } from "../sessions.ts";
import { openProjectFiles, StorageIOError } from "./files.ts";
import { encodeId, normalizedBytes } from "./records.ts";
import type { createFileSelections } from "./selections.ts";
import { importProjectPackage, importPublicationRecord, finishImportPublication } from "./package-transfer.ts";

type PackageSource = Awaited<ReturnType<ReturnType<typeof createFileSelections>["openPackage"]>>;
const attemptRecord = z.strictObject({ attemptId: z.string(), status: z.enum(["queued", "running", "cancel_requested", "succeeded", "failed", "interrupted", "cancelled"]),
  output: z.strictObject({ name: z.string(), directory: z.string(), projectId: z.string(), savePointId: z.string() }).nullable(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable() });
const record = attemptRecord.extend({ schemaVersion: z.literal(1), taskId: z.string(), importId: z.string(),
  request: z.strictObject({ key: z.string().min(1).max(128), parent: z.string(), name: z.string(), sourceIdentity: z.string() }),
  publication: importPublicationRecord.nullable(), attempts: z.array(attemptRecord).max(1000).default([]),
  retries: z.array(z.strictObject({ key: z.string().min(1).max(128), expectedAttemptId: z.string(), attemptId: z.string() })).max(1000).default([]) });
type ImportTask = z.infer<typeof record>;

export async function createMigrationImports(directory: string, executable: string) {
  const files = await openProjectFiles(directory, executable), running = new Map<string, Promise<void>>();
  const pages = new Map<string, Set<string>>();
  const controllers = new Map<string, AbortController>();
  let tail = Promise.resolve(), closing = false, accepting = 0, pending = 0;
  const serial = <T>(action: () => Promise<T>) => {
    pending++;
    const operation = tail.then(action).finally(() => { pending--; });
    tail = operation.then(() => {}, () => {}); return operation;
  };
  const path = (taskId: string) => `migrations/imports/${encodeId(taskId)}.json`;
  const read = async (taskId: string) => {
    try {
      const task = record.parse(JSON.parse((await files.read(path(taskId))).toString("utf8")));
      if (task.taskId !== taskId) throw new HostError("PROJECT_INVALID", 409, "Import task identity changed.");
      return task;
    } catch (error) { if (error instanceof StorageIOError && error.errno === 2) return null; throw error; }
  };
  const store = (task: ImportTask) => files.writeJson(path(task.taskId), record.parse(task), true);
  const run = async (task: ImportTask, source: PackageSource, signal: AbortSignal) => {
    const reconciling = Boolean(task.publication);
    try {
      task.status = "running"; await serial(() => store(task));
      signal.throwIfAborted(); await source.verify();
      const output = task.publication ? await finishImportPublication(task.publication, executable, signal) :
        await importProjectPackage(task.request.parent, task.request.name, executable, source, async receipt => {
          task.publication = receipt; await serial(() => store(task));
        }, signal);
      task.output = { name: output.name, directory: output.directory, projectId: output.projectId, savePointId: output.savePointId };
      task.status = "succeeded"; task.error = null; await serial(() => store(task));
    } catch (error) {
      const saved = await read(task.taskId);
      if (saved?.status === "succeeded") return;
      const cancelled = signal.aborted && (error instanceof HostError && error.code === "TASK_CANCELLED" || error instanceof Error && error.name === "AbortError");
      task.status = cancelled ? reconciling ? "interrupted" : "cancelled" : "failed";
      task.error = cancelled ? reconciling ? { code: "IMPORT_OUTCOME_UNKNOWN", message: "Import publication verification was interrupted." } : null :
        { code: error instanceof HostError ? error.code : "MIGRATION_FAILED", message: error instanceof HostError ? error.message : "Project import could not be confirmed." };
      await serial(() => store(task));
    } finally { await source.close(); }
  };
  const begin = (task: ImportTask, source: PackageSource) => {
    const controller = new AbortController(); controllers.set(task.taskId, controller);
    const job = run(task, source, controller.signal).finally(() => { running.delete(task.taskId); controllers.delete(task.taskId); });
    running.set(task.taskId, job); void job.catch(() => {});
  };
  return {
    async accept(page: PageSession, parent: string, name: string, key: string, source: PackageSource) {
      if (closing) { await source.close(); throw new HostError("TASKS_DRAINING", 409, "Project imports are closing."); }
      accepting++;
      let transferred = false;
      const operation = serial(async () => {
        const taskId = `import-${encodeId(key)}`, request = { key, parent, name, sourceIdentity: source.identity };
        let task = await read(taskId);
        const replayed = Boolean(task);
        if (task && !normalizedBytes(task.request).equals(normalizedBytes(request))) throw new HostError("IDEMPOTENCY_CONFLICT", 409, "This import key has different parameters.");
        if (!task) {
          task = record.parse({ schemaVersion: 1, taskId, importId: randomUUID(), attemptId: randomUUID(), request, status: "queued", publication: null, output: null, error: null });
          await files.mkdir("migrations/imports"); await store(task);
        }
        const owners = pages.get(taskId) ?? new Set<string>(); owners.add(page.pageSessionId); pages.set(taskId, owners);
        if (!replayed) {
          transferred = true;
          begin(task, source);
        }
        return { taskId, importId: task.importId, replayed };
      });
      try { return await operation; }
      finally { accepting--; if (!transferred) await source.close(); }
    },
    async task(page: PageSession, taskId: string) {
      if (!pages.get(taskId)?.has(page.pageSessionId)) return null;
      const task = await read(taskId);
      if (!task) return null;
      const status = ["queued", "running", "cancel_requested"].includes(task.status) && !running.has(taskId) ? "interrupted" : task.status;
      return { taskId, importId: task.importId, attemptId: task.attemptId, status, projectId: task.output?.projectId ?? null,
        output: task.output ? { name: task.output.name, projectId: task.output.projectId, savePointId: task.output.savePointId } : null, error: task.error };
    },
    async cancel(page: PageSession, taskId: string) {
      if (closing) throw new HostError("TASKS_DRAINING", 409, "Project imports are closing.");
      if (!pages.get(taskId)?.has(page.pageSessionId)) throw new HostError("TASK_NOT_FOUND", 404, "Select this import before cancelling it.");
      await serial(async () => {
        const task = await read(taskId);
        if (!task) throw new HostError("TASK_NOT_FOUND", 404, "Import task not found.");
        if (["succeeded", "cancelled"].includes(task.status)) return;
        if (running.has(taskId)) { task.status = "cancel_requested"; await store(task); controllers.get(taskId)!.abort(); }
        else {
          if (task.publication) throw new HostError("IMPORT_OUTCOME_UNKNOWN", 409, "Verify the imported directory before abandoning this task.");
          task.status = "cancelled"; task.error = null; await store(task);
        }
      });
      await running.get(taskId);
      const task = await this.task(page, taskId);
      return { taskId, status: task!.status };
    },
    async retry(page: PageSession, taskId: string, expectedAttemptId: string, key: string, source: PackageSource) {
      let transferred = false;
      try {
        if (closing) throw new HostError("TASKS_DRAINING", 409, "Project imports are closing.");
        if (!pages.get(taskId)?.has(page.pageSessionId)) throw new HostError("TASK_NOT_FOUND", 404, "Select this import before retrying it.");
        return await serial(async () => {
          const task = await read(taskId);
          if (!task) throw new HostError("TASK_NOT_FOUND", 404, "Import task not found.");
          if (task.request.sourceIdentity !== source.identity) throw new HostError("REFERENCE_STALE", 409, "Select the original unchanged package.");
          const prior = task.retries.find(item => item.key === key);
          if (prior) {
            if (prior.expectedAttemptId !== expectedAttemptId) throw new HostError("IDEMPOTENCY_CONFLICT", 409, "This retry key refers to another attempt.");
            return { taskId, importId: task.importId, attemptId: prior.attemptId, replayed: true };
          }
          if (task.attemptId !== expectedAttemptId || running.has(taskId) || ["succeeded", "cancelled"].includes(task.status)) throw new HostError("REFERENCE_STALE", 409, "Query the stopped import before retrying.");
          if (["queued", "running", "cancel_requested"].includes(task.status)) task.status = "interrupted";
          task.attempts.push({ attemptId: task.attemptId, status: task.status, output: task.output, error: task.error });
          task.attemptId = randomUUID(); task.status = "queued"; task.output = null; task.error = null;
          task.retries.push({ key, expectedAttemptId, attemptId: task.attemptId });
          await store(task); transferred = true; begin(task, source);
          return { taskId, importId: task.importId, attemptId: task.attemptId, replayed: false };
        });
      } finally { if (!transferred) await source.close(); }
    },
    busy: () => accepting > 0 || pending > 0 || running.size > 0,
    async close() { closing = true; await tail; await Promise.allSettled([...running.values()]); },
  };
}
