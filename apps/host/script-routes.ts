import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HostError, type PageSession } from "./sessions.ts";
import type { createProjects } from "./storage/projects.ts";
import { listScripts, prepareScript, readScriptObject, validateScriptSources } from "./storage/scripts.ts";
import { scriptRecord, scriptWrite, scriptSource, type ScriptSource } from "./storage/script-records.ts";
import { analysisRecord, rawAnalysisRecord } from "./storage/analysis-records.ts";
import { assetRecord } from "./storage/assets.ts";
import { inspectMedia } from "./storage/media.ts";
import { referenceKey } from "./storage/records.ts";

export function registerScriptRoutes(app: FastifyInstance, projects: ReturnType<typeof createProjects>,
  pageFor: (request: FastifyRequest) => PageSession, success: (request: FastifyRequest, data: unknown) => unknown,
  errorEnvelope: unknown) {
  const id = z.string().min(1).max(256), empty = z.strictObject({}), params = z.strictObject({ projectId: id });
  const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" });
  const responses = (schema: z.ZodType) => ({ 200: json(z.strictObject({ ok: z.literal(true), data: schema,
    meta: z.strictObject({ requestId: id, protocolVersion: z.literal(1) }) })), "4xx": errorEnvelope, "5xx": errorEnvelope });
  const confirmations = new Map<string, { page: string; directory: string; scriptId: string; revision: number; digest: string; expires: number }>();
  const key = (request: FastifyRequest) => {
    const value = request.headers["idempotency-key"];
    if (typeof value !== "string" || !value.length || value.length > 128) throw new HostError("INVALID_ARGUMENT", 400, "Idempotency-Key is required.");
    return value;
  };
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/scripts", {
    schema: { params: json(params), querystring: json(empty), response: responses(z.strictObject({ items: z.array(scriptRecord.extend({ sourcesCurrent: z.boolean() })) })) },
  }, async request => {
    const project = projects.get(pageFor(request), request.params.projectId);
    const current = project.commits.current();
    const items = await Promise.all((await listScripts(project.files, current)).map(async item => {
      let sourcesCurrent = true;
      try { await validateScriptSources(project.files, current, item.draft, true); }
      catch (error) { if (error instanceof HostError && ["REFERENCE_STALE", "REFERENCE_INVALID"].includes(error.code)) sourcesCurrent = false; else throw error; }
      return { ...item, sourcesCurrent };
    }));
    return success(request, { items });
  });
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/script-sources", {
    schema: { params: json(params), querystring: json(empty), response: responses(z.strictObject({ items: z.array(scriptSource) })) },
  }, async request => {
    const project = projects.get(pageFor(request), request.params.projectId), current = project.commits.current();
    const items: ScriptSource[] = [];
    for (const ref of current?.roots.analyses ?? []) {
      const parsed = analysisRecord.safeParse(await readScriptObject(project.files, current, ref));
      if (!parsed.success) continue;
      const analysis = parsed.data;
      const raw = analysis.format === "material-analysis" ? analysis : rawAnalysisRecord.parse(await readScriptObject(project.files, current, analysis.rawRef));
      if (!current?.roots.assets.some(ref => ref.entityId === raw.basis.assetRef.entityId && ref.revision === raw.basis.assetRef.revision)) continue;
      const asset = assetRecord.parse(await readScriptObject(project.files, current, raw.basis.assetRef));
      const ranges = analysis.format === "material-analysis-correction" && analysis.correction.intervals.length ?
        analysis.correction.intervals : [{ range: raw.basis.range,
          text: analysis.format === "material-analysis-correction" ? analysis.correction.text : raw.output.text,
          labels: [], visualNotes: raw.output.samples.map(item => item.description || item.detections.map(value => value.label).join(", ")).join("\n") }];
      for (const [index, range] of ranges.entries()) items.push(scriptSource.parse({ sourceId: `${analysis.analysisId}:${analysis.revision}:${index}`,
        assetRef: raw.basis.assetRef, mediaRef: raw.basis.mediaRef, analysisRef: ref, range: range.range,
        kind: asset.kind, capability: raw.basis.capability, originalText: range.text, visualNotes: range.visualNotes, labels: range.labels }));
    }
    for (const ref of current?.roots.assets ?? []) {
      if (items.some(source => source.assetRef.entityId === ref.entityId)) continue;
      const asset = assetRecord.parse(await readScriptObject(project.files, current, ref));
      const media = current?.objects.find(object => referenceKey(object) === referenceKey(asset.mediaRef));
      if (!media) throw new HostError("REFERENCE_INVALID", 409, "A registered source has no media object.");
      const inspected = await inspectMedia(project.files, media.path, media.sizeBytes, true);
      items.push(scriptSource.parse({ sourceId: `unanalysed:${asset.assetId}`, assetRef: ref, mediaRef: asset.mediaRef,
        analysisRef: null, range: { sourceStartSeconds: 0, sourceEndSeconds: inspected.durationSeconds }, kind: asset.kind,
        capability: "unanalysed", originalText: "", visualNotes: "", labels: [] }));
    }
    return success(request, { items });
  });
  const scriptParams = params.extend({ scriptId: id });
  app.get<{ Params: { projectId: string; scriptId: string } }>("/api/v1/projects/:projectId/scripts/:scriptId/history", {
    schema: { params: json(scriptParams), querystring: json(empty), response: responses(z.strictObject({ items: z.array(scriptRecord) })) },
  }, async request => {
    const project = projects.get(pageFor(request), request.params.projectId), current = project.commits.current();
    const items = [];
    for (const object of current?.objects ?? []) if (object.kind === "script" && object.entityId === request.params.scriptId) {
      items.push(scriptRecord.parse(await readScriptObject(project.files, current, object)));
    }
    items.sort((a, b) => b.revision - a.revision);
    return success(request, { items });
  });
  const confirmationBody = z.strictObject({ editorSessionId: id, revision: z.number().int().positive().safe(), digest: z.string().length(64) });
  app.post<{ Params: { projectId: string; scriptId: string }; Body: z.infer<typeof confirmationBody> }>("/api/v1/projects/:projectId/scripts/:scriptId/confirmations", {
    schema: { params: json(scriptParams), querystring: json(empty), body: json(confirmationBody), response: responses(z.strictObject({ confirmationId: id })) },
  }, async request => {
    const page = pageFor(request), { projectId, scriptId } = request.params;
    projects.editors.requireWrite(page, request.body.editorSessionId, projectId);
    const project = projects.get(page, projectId), current = project.commits.current();
    const ref = current?.roots.scripts.find(ref => ref.entityId === scriptId && ref.revision === request.body.revision);
    if (!ref) throw new HostError("REVISION_CONFLICT", 409, "Save and review the current script first.");
    const record = scriptRecord.parse(await readScriptObject(project.files, current, ref));
    if (record.digest !== request.body.digest) throw new HostError("REFERENCE_STALE", 409, "The reviewed script changed.");
    await validateScriptSources(project.files, current, record.draft, true);
    for (const [key, value] of confirmations) if (value.expires <= Date.now()) confirmations.delete(key);
    if (confirmations.size >= 128) throw new HostError("RESOURCE_BUSY", 429, "Too many pending confirmations.");
    const confirmationId = randomUUID();
    confirmations.set(confirmationId, { page: page.pageSessionId, directory: project.files.directory, scriptId,
      revision: record.revision, digest: record.digest, expires: Math.min(Date.now() + 60_000, Date.parse(page.expiresAt)) });
    return success(request, { confirmationId });
  });
  const body = scriptWrite.extend({ editorSessionId: id, confirmationId: id.nullable() });
  const receipt = z.strictObject({ saveId: id, status: z.enum(["queued", "writing", "failed", "succeeded"]), replayed: z.boolean(),
    error: z.strictObject({ code: id, message: z.string().max(1024) }).nullable() });
  for (const suffix of ["scripts", "scripts/:scriptId/revisions"]) app.post<{ Params: { projectId: string; scriptId?: string }; Body: z.infer<typeof body> }>(`/api/v1/projects/:projectId/${suffix}`, {
    bodyLimit: 16 * 1024 * 1024,
    schema: { params: json(suffix === "scripts" ? params : scriptParams), querystring: json(empty), body: json(body), response: responses(receipt) },
  }, async request => {
    const page = pageFor(request), { projectId } = request.params, scriptId = request.params.scriptId ?? request.body.scriptId;
    const { editorSessionId, confirmationId, ...input } = request.body;
    if (suffix === "scripts" && input.expectedRevision !== 0) throw new HostError("INVALID_ARGUMENT", 400, "Script creation requires expectedRevision zero.");
    if (input.scriptId !== scriptId) throw new HostError("INVALID_ARGUMENT", 400, "Script identity differs from the route.");
    projects.editors.requireWrite(page, editorSessionId, projectId);
    const project = projects.get(page, projectId);
    const result = await project.commits.accept({ route: "review-script", subject: scriptId, idempotencyKey: key(request), request: input,
      editorSnapshotId: null, editorSequence: null }, prepareScript(project.files, projectId), () => {
      projects.editors.requireWrite(page, editorSessionId, projectId);
      if (input.confirmDigest !== null) {
        const confirmation = confirmationId ? confirmations.get(confirmationId) : null;
        if (!confirmation || confirmation.page !== page.pageSessionId || confirmation.directory !== project.files.directory ||
            confirmation.scriptId !== scriptId || confirmation.revision !== input.expectedRevision || confirmation.digest !== input.confirmDigest || confirmation.expires <= Date.now()) {
          throw new HostError("USER_CONFIRMATION_REQUIRED", 403, "Confirm this exact script revision in the current page.");
        }
        confirmations.delete(confirmationId!);
      }
    });
    await project.commits.drain();
    const saved = project.commits.get(result.save.saveId);
    return success(request, { saveId: saved.saveId, status: saved.status, replayed: result.replayed, error: saved.error ?? null });
  });
}
