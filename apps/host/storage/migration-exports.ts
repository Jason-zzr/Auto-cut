import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HostError } from "../sessions.ts";
import type { createProjectCommits } from "./commits.ts";
import { StorageIOError, type ProjectFiles } from "./files.ts";
import { encodeId, normalizedBytes, sha256 } from "./records.ts";
import { createMigrationPin, readMigrationPin, recordMigrationPublication, releaseMigrationPin } from "./migration-pins.ts";
import { preparePackageSource } from "./package-source.ts";
import { exportProjectPackage, finishExportPublication } from "./package-transfer.ts";

const attemptRecord = z.strictObject({ attemptId: z.string(),
  status: z.enum(["queued", "running", "cancel_requested", "succeeded", "failed", "interrupted", "cancelled"]),
  output: z.strictObject({ name: z.string(), sizeBytes: z.number().int().positive(), sha256: z.string() }).nullable(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable() });
const taskRecord = attemptRecord.extend({ schemaVersion: z.literal(1), projectId: z.string(), taskId: z.string(), exportId: z.string(),
  request: z.strictObject({ key: z.string().min(1).max(128), savePointId: z.string(), parent: z.string(), name: z.string() }),
  attempts: z.array(attemptRecord).max(1000).default([]),
  retries: z.array(z.strictObject({ key: z.string().min(1).max(128), expectedAttemptId: z.string(), attemptId: z.string() })).max(1000).default([]) });
type ExportTask = z.infer<typeof taskRecord>;

export function createMigrationExports(files: ProjectFiles, commits: Awaited<ReturnType<typeof createProjectCommits>>, executable: string, appVersion: string) {
  const running = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  let accepting = 0;
  const acceptedWaiters = new Set<() => void>();
  let closing = false;
  const path = (taskId: string) => `staging/migration-exports/${encodeId(taskId)}.json`;
  const read = async (taskId: string) => {
    try {
      const task = taskRecord.parse(JSON.parse((await files.read(path(taskId))).toString("utf8")));
      if (task.taskId !== taskId || task.projectId !== commits.current()?.projectId) throw new HostError("PROJECT_INVALID", 409, "Export task identity changed.");
      return task;
    } catch (error) { if (error instanceof StorageIOError && error.errno === 2) return null; throw error; }
  };
  const store = (task: ExportTask) => files.writeJson(path(task.taskId), taskRecord.parse(task), true);
  const persist = (task: ExportTask) => commits.maintain(() => store(task));
  const run = async (task: ExportTask, signal: AbortSignal) => {
    let reconciling = true;
    try {
      task.status = "running"; await persist(task);
      const pin = await readMigrationPin(files, task.projectId, task.exportId);
      reconciling = Boolean(pin.publication);
      signal.throwIfAborted();
      const output = pin.publication ? await finishExportPublication(pin.publication, executable, signal) : await exportProjectPackage(task.request.parent, task.request.name, executable,
        await preparePackageSource(files, task.projectId, task.exportId, appVersion), receipt => commits.maintain(async () => {
          await recordMigrationPublication(files, task.projectId, task.exportId, receipt);
        }), signal);
      task.output = { name: output.name, sizeBytes: output.sizeBytes, sha256: output.sha256 };
      task.status = "succeeded"; task.error = null;
      await persist(task);
      await commits.maintain(() => releaseMigrationPin(files, task.projectId, task.exportId, "completed"));
    } catch (error) {
      // A durable success remains a success even if releasing its pin must be retried.
      const saved = await read(task.taskId);
      if (saved?.status === "succeeded") return;
      const cancelled = signal.aborted && (error instanceof HostError && error.code === "TASK_CANCELLED" || error instanceof Error && error.name === "AbortError");
      task.status = cancelled ? reconciling ? "interrupted" : "cancelled" : "failed";
      task.error = cancelled ? reconciling ? { code: "EXPORT_OUTCOME_UNKNOWN", message: "Output verification stopped before the publication outcome was confirmed." } : null :
        { code: error instanceof HostError ? error.code : "MIGRATION_FAILED", message: error instanceof HostError ? error.message : "Project export could not be completed." };
      await persist(task);
      if (task.status === "cancelled") await commits.maintain(() => releaseMigrationPin(files, task.projectId, task.exportId, "abandoned"));
    }
  };
  const begin = (task: ExportTask) => {
    const controller = new AbortController(); controllers.set(task.taskId, controller);
    const operation = run(task, controller.signal).finally(() => { running.delete(task.taskId); controllers.delete(task.taskId); });
    running.set(task.taskId, operation); void operation.catch(() => {});
  };
  return {
    async accept(request: ExportTask["request"]) {
      if (closing) throw new HostError("TASKS_DRAINING", 409, "Project exports are closing.");
      accepting++;
      try {
      const taskId = `export-${sha256(normalizedBytes({ projectId: commits.current()?.projectId, key: request.key }))}`;
      const accepted = await commits.maintain(async (current, entry) => {
        const existing = await read(taskId);
        if (existing) {
          if (!normalizedBytes(existing.request).equals(normalizedBytes(request))) throw new HostError("IDEMPOTENCY_CONFLICT", 409, "This export key has different parameters.");
          return { task: existing, replayed: true };
        }
        const exportId = taskId;
        let pin = null;
        try { pin = await readMigrationPin(files, current.projectId, exportId); }
        catch (error) { if (!(error instanceof StorageIOError) || error.errno !== 2) throw error; }
        // Pin publication may have succeeded before the task record or its reply was lost.
        if ((pin?.savePointId ?? current.savePointId) !== request.savePointId) throw new HostError("REFERENCE_STALE", 409, "The selected save point is no longer current or pinned.");
        await createMigrationPin(files, current, entry, exportId, sha256(normalizedBytes(request)));
        const task = taskRecord.parse({ schemaVersion: 1, projectId: current.projectId, taskId, exportId, attemptId: randomUUID(), request,
          status: "queued", output: null, error: null });
        await files.mkdir("staging/migration-exports"); await store(task);
        return { task, replayed: false };
      });
      if (!accepted.replayed) begin(accepted.task);
      return { taskId, exportId: accepted.task.exportId, savePointId: accepted.task.request.savePointId, replayed: accepted.replayed };
      } finally {
        accepting--;
        if (!accepting) { for (const resolve of acceptedWaiters) resolve(); acceptedWaiters.clear(); }
      }
    },
    async task(taskId: string) {
      const task = await read(taskId);
      if (!task) return null;
      if (["queued", "running", "cancel_requested"].includes(task.status) && !running.has(taskId)) {
        task.status = "interrupted"; task.error = { code: "MIGRATION_INTERRUPTED", message: "The export stopped before its result was confirmed. Its source remains protected." };
      }
      return { taskId: task.taskId, projectId: task.projectId, exportId: task.exportId, attemptId: task.attemptId,
        status: task.status, savePointId: task.request.savePointId, output: task.output, error: task.error };
    },
    async retry(taskId: string, expectedAttemptId: string, key: string) {
      if (closing) throw new HostError("TASKS_DRAINING", 409, "Project exports are closing.");
      accepting++;
      try {
        const accepted = await commits.maintain(async () => {
          const task = await read(taskId);
          if (!task) return null;
          const prior = task.retries.find(item => item.key === key);
          if (prior) {
            if (prior.expectedAttemptId !== expectedAttemptId) throw new HostError("IDEMPOTENCY_CONFLICT", 409, "This retry key refers to another attempt.");
            return { task, attemptId: prior.attemptId, replayed: true };
          }
          if (task.attemptId !== expectedAttemptId || running.has(taskId) || ["succeeded", "cancelled"].includes(task.status)) {
            throw new HostError("REFERENCE_STALE", 409, "Query the export before retrying its stopped attempt.");
          }
          const pin = await readMigrationPin(files, task.projectId, task.exportId);
          if (pin.status !== "active") throw new HostError("EXPORT_FINISHED", 409, "This export no longer protects its source.");
          if (["queued", "running", "cancel_requested"].includes(task.status)) task.status = "interrupted";
          task.attempts.push({ attemptId: task.attemptId, status: task.status, output: task.output, error: task.error });
          task.attemptId = randomUUID(); task.status = "queued"; task.output = null; task.error = null;
          task.retries.push({ key, expectedAttemptId, attemptId: task.attemptId });
          await store(task);
          return { task, attemptId: task.attemptId, replayed: false };
        });
        if (!accepted) return null;
        if (!accepted.replayed) begin(accepted.task);
        return { taskId, exportId: accepted.task.exportId, attemptId: accepted.attemptId, replayed: accepted.replayed };
      } finally {
        accepting--;
        if (!accepting) { for (const resolve of acceptedWaiters) resolve(); acceptedWaiters.clear(); }
      }
    },
    async cancel(taskId: string) {
      if (closing) throw new HostError("TASKS_DRAINING", 409, "Project exports are closing.");
      const found = await commits.maintain(async () => {
        const task = await read(taskId);
        if (!task) return false;
        if (task.status === "succeeded") {
          await releaseMigrationPin(files, task.projectId, task.exportId, "completed"); return true;
        }
        if (running.has(taskId)) {
          task.status = "cancel_requested"; await store(task); controllers.get(taskId)!.abort();
        } else {
          const pin = await readMigrationPin(files, task.projectId, task.exportId);
          if (pin.publication && task.status !== "cancelled") throw new HostError("EXPORT_OUTCOME_UNKNOWN", 409, "Reconcile the verified output before abandoning this export.");
          task.status = "cancelled"; task.error = null; await store(task);
          await releaseMigrationPin(files, task.projectId, task.exportId, "abandoned");
        }
        return true;
      });
      if (!found) return null;
      await running.get(taskId);
      return this.task(taskId);
    },
    busy: () => accepting > 0 || running.size > 0,
    async close() {
      closing = true;
      if (accepting) await new Promise<void>(resolve => acceptedWaiters.add(resolve));
      await Promise.allSettled([...running.values()]);
    },
  };
}
