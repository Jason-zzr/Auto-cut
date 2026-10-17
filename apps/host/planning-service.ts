import { randomUUID } from "node:crypto";
import { HostError, type PageSession } from "./sessions.ts";
import type { createProjects } from "./storage/projects.ts";
import type { createPlanningConfig } from "./planning-config.ts";
import { planningRequestText, generatePlanningContent, planningEndpoint } from "./planning-provider.ts";
import { planningTaskRecord, type PlanningTask } from "./storage/planning-records.ts";
import { preparePlanningTask } from "./storage/planning-tasks.ts";
import { readScriptObject, prepareScript, validateScriptSources } from "./storage/scripts.ts";
import { scriptRecord, scriptProvider, type ScriptRecord } from "./storage/script-records.ts";
import { encodeId, sha256 } from "./storage/records.ts";
import { planningContext } from "./planning-context.ts";

type Projects = ReturnType<typeof createProjects>;
type Project = ReturnType<Projects["get"]>;
export function createPlanningService(projects: Projects, config: ReturnType<typeof createPlanningConfig>) {
  const grants = new Map<string, { page: string; directory: string; record: ScriptRecord; providerDigest: string; inputText: string; groups: PlanningTask["groups"]; expires: number }>();
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let closing = false;
  const identity = (project: Project, taskId: string) => `${project.files.directory}\0${taskId}`;
  const load = async (project: Project, taskId: string) => {
    const ref = project.commits.current()?.roots.tasks.find(ref => ref.entityId === taskId);
    if (!ref) throw new HostError("TASK_NOT_FOUND", 404, "Planning task not found.");
    return planningTaskRecord.parse(await readScriptObject(project.files, project.commits.current(), ref));
  };
  const persist = async (project: Project, task: PlanningTask) => {
    const result = await project.commits.accept({ route: "script-planning", subject: task.taskId,
      idempotencyKey: `${task.attemptId}:${task.revision}`, request: task, editorSnapshotId: null, editorSequence: null },
    preparePlanningTask(project.files, project.projectId));
    await project.commits.drain();
    const saved = project.commits.get(result.save.saveId);
    if (saved.status !== "succeeded") throw new HostError("STORAGE_IO_FAILED", 503, "The planning task state was not committed; no automatic request retry will occur.");
    return task;
  };
  const advance = (task: PlanningTask, fields: Partial<PlanningTask>): PlanningTask => ({ ...task, ...fields,
    revision: task.revision + 1, previousRef: { kind: "task", entityId: task.taskId, revision: task.revision }, updatedAt: new Date().toISOString() });
  const register = async (project: Project, task: PlanningTask) => {
    if (!task.output) throw new HostError("RESULT_NOT_READY", 409, "This task has no verified output to register.");
    const scriptId = task.taskId;
    const existing = project.commits.current()?.roots.scripts.find(ref => ref.entityId === scriptId);
    if (!existing) {
      const saved = await project.commits.accept({ route: "review-script", subject: scriptId, idempotencyKey: randomUUID(),
        request: { scriptId, expectedRevision: 0, draft: task.output, createdAt: task.createdAt, confirmDigest: null }, editorSnapshotId: null, editorSequence: null }, prepareScript(project.files, project.projectId));
      await project.commits.drain();
      if (project.commits.get(saved.save.saveId).status !== "succeeded") throw new HostError("STORAGE_IO_FAILED", 503, "The output is retained. Retry registration without generating again.");
    }
    return persist(project, advance(task, { status: "registered", scriptRef: { kind: "script", entityId: scriptId, revision: 1 } }));
  };
  const execute = async (project: Project, task: PlanningTask, key: string, controller: AbortController) => {
    try {
      for (let index = 0; index < task.groups.length; index++) {
        if (task.groups[index].output) continue;
        task = await persist(project, advance(task, { status: "dispatched", activeGroup: index }));
        const group = task.groups[index];
        const result = await generatePlanningContent(task.provider, key, group.inputText, controller.signal);
        const sourceIds = new Set(JSON.parse(group.inputText).input.sources.map((source: { sourceId: string }) => source.sourceId));
        await validateScriptSources(project.files, project.commits.current(), { ...task.basis,
          sources: task.basis.sources.filter(source => sourceIds.has(source.sourceId)), content: result.content });
        const groups = structuredClone(task.groups); groups[index] = { ...group, output: result.content, remoteId: result.remoteId };
        task = await persist(project, advance(task, { status: "prepared", groups, activeGroup: null }));
      }
      let result = { content: task.groups[0].output!, remoteId: task.groups[0].remoteId! };
      if (task.groups.length > 1) {
        const mergeText = planningRequestText({ goals: task.basis.goals, feedback: task.basis.feedback,
          groups: task.groups.map(group => ({ ...group.output!, segments: group.output!.segments.map(({ originalText: _originalText, ...segment }) => segment) })) });
        if (Buffer.byteLength(mergeText) > task.provider.maxInputBytes) throw new HostError("RESOURCE_LIMIT_EXCEEDED", 400, "Classified groups are retained, but the merge exceeds the configured input limit. Reduce the source selection or increase the limit.");
        task = await persist(project, advance(task, { status: "dispatched", activeGroup: null }));
        result = await generatePlanningContent(task.provider, key, mergeText, controller.signal, true);
        for (const segment of result.content.segments) if (segment.kind === "sourceSpeech") {
          if (segment.originalText !== "") throw new HostError("PROVIDER_OUTPUT_INVALID", 502, "The merge supplied unsupported original words.");
          segment.originalText = segment.sourceIds.map(id => task.basis.sources.find(source => source.sourceId === id)?.originalText ?? "").join("\n");
        }
      }
      const { providerId, revision, protocol, baseUrl, model } = task.provider;
      const output = { ...task.basis, content: result.content, provider: scriptProvider.parse({ providerId, revision, protocol, baseUrl, model }) };
      await validateScriptSources(project.files, project.commits.current(), output);
      const next = advance(task, { status: "output_ready", output, remoteId: result.remoteId });
      await project.files.mkdir("staging/planning");
      await project.files.writeJson(`staging/planning/${encodeId(task.taskId)}.json`, next);
      task = await persist(project, next);
      await register(project, task);
    } catch (error) {
      if (task.status === "dispatched" || task.status === "prepared") {
        const code = error instanceof HostError ? error.code : "PROVIDER_OUTCOME_UNKNOWN";
        await persist(project, advance(task, { status: task.status === "prepared" || ["PROVIDER_OUTPUT_INVALID", "REFERENCE_INVALID", "REFERENCE_STALE"].includes(code) ? "failed" : "remote_unknown",
          error: code })).catch(() => {});
      }
    }
  };
  const write = (page: PageSession, projectId: string, editorSessionId: string) => {
    if (closing) throw new HostError("TASKS_DRAINING", 409, "Planning is stopping.");
    projects.editors.requireWrite(page, editorSessionId, projectId);
    return projects.get(page, projectId);
  };
  return {
    async preview(page: PageSession, projectId: string, editorSessionId: string, scriptId: string, revision: number) {
      const project = write(page, projectId, editorSessionId), current = project.commits.current();
      const ref = current?.roots.scripts.find(ref => ref.entityId === scriptId && ref.revision === revision);
      if (!ref) throw new HostError("REVISION_CONFLICT", 409, "Save the current draft before reviewing an outgoing request.");
      const record = scriptRecord.parse(await readScriptObject(project.files, current, ref));
      await validateScriptSources(project.files, current, record.draft, true);
      const provider = (await config.get()).config;
      const { inputText, groups } = planningContext(record.draft, provider.maxInputBytes);
      for (const [id, item] of grants) if (item.expires <= Date.now()) grants.delete(id);
      if (grants.size >= 128) throw new HostError("RESOURCE_BUSY", 429, "Too many pending outgoing previews.");
      const confirmationId = randomUUID();
      grants.set(confirmationId, { page: page.pageSessionId, directory: project.files.directory, record,
        providerDigest: config.digest(provider), inputText, groups, expires: Math.min(Date.now() + 300_000, Date.parse(page.expiresAt)) });
      return { confirmationId, inputText, inputDigest: sha256(Buffer.from(inputText)), destination: planningEndpoint(provider),
        model: provider.model, providerId: provider.providerId, cost: "unknown" as const };
    },
    async start(page: PageSession, projectId: string, editorSessionId: string, confirmationId: string, idempotencyKey: string) {
      const project = write(page, projectId, editorSessionId), taskId = encodeId(`${page.pageSessionId}:${idempotencyKey}`);
      const old = project.commits.current()?.roots.tasks.find(ref => ref.entityId === taskId);
      const requestDigest = sha256(Buffer.from(confirmationId));
      if (old) {
        const task = await load(project, taskId);
        if (task.requestDigest !== requestDigest) throw new HostError("IDEMPOTENCY_KEY_REUSED", 409, "This request key belongs to another outgoing confirmation.");
        return task;
      }
      const grant = grants.get(confirmationId), provider = await config.get();
      if (!grant || grant.page !== page.pageSessionId || grant.directory !== project.files.directory || grant.expires <= Date.now() ||
          grant.providerDigest !== config.digest(provider.config) || !project.commits.current()?.roots.scripts.some(ref =>
            ref.entityId === grant.record.scriptId && ref.revision === grant.record.revision)) {
        throw new HostError("USER_CONFIRMATION_REQUIRED", 403, "Review and confirm the exact destination, model and outgoing text again.");
      }
      await validateScriptSources(project.files, project.commits.current(), grant.record.draft, true);
      if (grants.get(confirmationId) !== grant) throw new HostError("USER_CONFIRMATION_REQUIRED", 403, "The outgoing confirmation was already used.");
      grants.delete(confirmationId);
      const secret = await config.key(provider.credentialIdentity);
      const groups = structuredClone(grant.groups);
      for (const ref of project.commits.current()?.roots.tasks ?? []) {
        const previous = planningTaskRecord.safeParse(await readScriptObject(project.files, project.commits.current(), ref));
        if (!previous.success || config.digest(previous.data.provider) !== config.digest(provider.config)) continue;
        for (const group of groups) {
          const cached = previous.data.groups.find(value => value.digest === group.digest && value.output);
          if (cached) { group.output = cached.output; group.remoteId = cached.remoteId; }
        }
      }
      const now = new Date().toISOString();
      const task = await persist(project, planningTaskRecord.parse({ schemaVersion: 1, format: "script-planning-task", projectId,
        taskId, revision: 1, previousRef: null, attemptId: randomUUID(), status: "prepared", provider: provider.config,
        requestDigest, inputDigest: sha256(Buffer.from(grant.inputText)), inputText: grant.inputText, groups, activeGroup: null, basis: grant.record.draft,
        output: null, remoteId: null, scriptRef: null, error: "", createdAt: now, updatedAt: now }));
      const controller = new AbortController(), id = identity(project, taskId);
      const done = execute(project, task, secret, controller).finally(() => active.delete(id));
      active.set(id, { controller, done });
      return task;
    },
    async list(page: PageSession, projectId: string) {
      const project = projects.get(page, projectId), items: PlanningTask[] = [];
      for (const ref of project.commits.current()?.roots.tasks ?? []) {
        const value = planningTaskRecord.safeParse(await readScriptObject(project.files, project.commits.current(), ref));
        if (value.success) items.push(value.data.status === "dispatched" && !active.has(identity(project, value.data.taskId)) ?
          { ...value.data, status: "remote_unknown" } : value.data);
      }
      return { items };
    },
    async cancel(page: PageSession, projectId: string, editorSessionId: string, taskId: string) {
      const project = write(page, projectId, editorSessionId);
      const running = active.get(identity(project, taskId));
      running?.controller.abort();
      if (running) await running.done;
      return load(project, taskId);
    },
    async retryRegistration(page: PageSession, projectId: string, editorSessionId: string, taskId: string) {
      const project = write(page, projectId, editorSessionId);
      if (active.has(identity(project, taskId))) throw new HostError("RESOURCE_BUSY", 409, "The task is still running.");
      let task = await load(project, taskId);
      if (task.status === "registered") return task;
      if (!task.output) {
        const staged = planningTaskRecord.parse(JSON.parse((await project.files.read(`staging/planning/${encodeId(taskId)}.json`)).toString("utf8")));
        if (staged.taskId !== taskId || staged.attemptId !== task.attemptId || staged.inputDigest !== task.inputDigest || !staged.output) throw new HostError("REFERENCE_INVALID", 409, "The retained output identity differs.");
        task = await persist(project, advance(task, { status: "output_ready", output: staged.output, remoteId: staged.remoteId }));
      }
      return register(project, task);
    },
    busy: () => active.size > 0,
    async close() { closing = true; grants.clear(); for (const value of active.values()) value.controller.abort(); await Promise.allSettled([...active.values()].map(value => value.done)); },
  };
}
