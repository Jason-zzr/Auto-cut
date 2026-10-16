import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HostError } from "../sessions.ts";
import { type ProjectFiles, StorageIOError } from "./files.ts";
import { commitPath, commitRecord, encodeId, entryRecord, jsonBytes, normalizedBytes, manifestRecord, referenceKey,
  saveRecord, sha256, type Commit, type Entry, type Manifest, type Save } from "./records.ts";
import { verifyObject } from "./objects.ts";
import { retainProjectClosure, verifyProjectClosure } from "./closure.ts";
import { collectProjectGarbage } from "./retention.ts";

type Candidate = Pick<Manifest, "roots" | "objects" | "editorSnapshotId" | "editorSequence">;
type Prepare = (current: Manifest | null, save: Save) => Promise<Candidate>;
type AcceptedRequest = Pick<Save, "route" | "subject" | "idempotencyKey" | "request" | "editorSnapshotId" | "editorSequence">;
const invalid = () => new HostError("PROJECT_INVALID", 409, "Project records are incomplete or damaged.");
const conflict = () => new HostError("SAVE_CHAIN_CONFLICT", 409, "Project commit history conflicts. Writable recovery has stopped.");

type CommitFile = { record: Commit; path: string; digest: string };
export const recoveryChoice = z.strictObject({ currentSavePointId: z.string().min(1).max(256),
  currentCommitSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currentCommitSha256: z.string().length(64),
  previousSavePointId: z.string().min(1).max(256) });
export type RecoveryChoice = z.infer<typeof recoveryChoice>;
const pointReference = (item: CommitFile) => ({ commitSequence: item.record.commitSequence, savePointId: item.record.savePointId,
  commitPath: item.path, commitSha256: item.digest });
function retainedPrevious(commits: CommitFile[]) {
  const head = commits.at(-1);
  return head?.record.recoveredFromSavePointId ? commits.findIndex(item => item.record.savePointId === head.record.recoveredFromSavePointId) : commits.length - 2;
}
async function readCommitChain(files: ProjectFiles, projectId?: string) {
  const commits: CommitFile[] = [];
  for (const path of await files.list("saves/commits")) {
    if (!path.endsWith(".json")) continue;
    const bytes = await files.read(`saves/commits/${path}`);
    let record: Commit;
    try { record = commitRecord.parse(JSON.parse(bytes.toString("utf8"))); } catch { throw conflict(); }
    projectId ??= record.projectId;
    if (record.projectId !== projectId || commitPath(record.commitSequence, record.savePointId) !== `saves/commits/${path}`) throw conflict();
    commits.push({ record, path: `saves/commits/${path}`, digest: sha256(bytes) });
  }
  commits.sort((a, b) => a.record.commitSequence - b.record.commitSequence);
  const saves = new Set<string>(), points = new Set<string>();
  for (let index = 0; index < commits.length; index++) {
    const { record } = commits[index];
    if (record.commitSequence !== index + 1 || record.previousCommitSequence !== index || saves.has(record.saveId) || points.has(record.savePointId)) throw conflict();
    if (record.recoveredFromSavePointId && !points.has(record.recoveredFromSavePointId)) throw conflict();
    saves.add(record.saveId); points.add(record.savePointId);
  }
  return commits;
}

async function readCompatibleEntry(files: ProjectFiles, commits: CommitFile[], projectId: string) {
  let entry: Entry | null = null;
  try { entry = entryRecord.parse(JSON.parse((await files.read("project.json")).toString("utf8"))); }
  catch (error) { if (error instanceof StorageIOError && error.errno !== 2) throw error; }
  if (entry && (entry.projectId !== projectId || !commits.some(item =>
    item.record.commitSequence === entry!.current.commitSequence && item.digest === entry!.current.commitSha256 &&
    item.path === entry!.current.commitPath && item.record.savePointId === entry!.current.savePointId))) throw conflict();
  return entry;
}

async function verifyManifest(files: ProjectFiles, value: Manifest) {
  const identities = new Set<string>(), paths = new Set<string>();
  for (const object of value.objects) {
    const key = referenceKey(object), path = object.path.normalize("NFC").toLowerCase();
    if (identities.has(key) || paths.has(path) || !["data", "media", "resources"].includes(object.path.split("/")[0])) throw invalid();
    identities.add(key); paths.add(path);
    await verifyObject(files, object);
  }
  for (const refs of Object.values(value.roots)) for (const ref of refs) if (!identities.has(referenceKey(ref))) throw invalid();
  if ((value.editorSnapshotId === null) !== (value.editorSequence === null)) throw invalid();
  if (value.editorSnapshotId !== null && !value.roots.editorSnapshots.some(ref => ref.kind === "editor-snapshot" && ref.entityId === value.editorSnapshotId)) throw invalid();
  await verifyProjectClosure(files, value);
}

async function readPoint(files: ProjectFiles, commits: CommitFile[], index: number) {
  const { record } = commits[index];
  const bytes = await files.read(record.manifest.path);
  if (bytes.length !== record.manifest.sizeBytes || sha256(bytes) !== record.manifest.sha256) throw invalid();
  let manifest: Manifest;
  try { manifest = manifestRecord.parse(JSON.parse(bytes.toString("utf8"))); } catch { throw invalid(); }
  if (manifest.projectId !== record.projectId || manifest.saveId !== record.saveId || manifest.savePointId !== record.savePointId ||
      record.manifest.path !== `saves/points/${encodeId(manifest.savePointId)}/manifest.json` ||
      manifest.previousSavePointId !== (commits[index - 1]?.record.savePointId ?? null)) throw invalid();
  await verifyManifest(files, manifest);
  return manifest;
}

export async function validateImportedProject(files: ProjectFiles, projectId: string, savePointId: string) {
  const entry = entryRecord.parse(JSON.parse((await files.read("project.json")).toString("utf8")));
  const commits = await readCommitChain(files, projectId), head = commits.at(-1);
  if (!head || entry.projectId !== projectId || head.record.savePointId !== savePointId ||
      !normalizedBytes(entry.current).equals(normalizedBytes(pointReference(head)))) throw invalid();
  const current = await readPoint(files, commits, commits.length - 1);
  const previousIndex = retainedPrevious(commits);
  const expectedPrevious = previousIndex >= 0 ? pointReference(commits[previousIndex]) : null;
  if (entry.previous !== null) {
    if (!normalizedBytes(entry.previous).equals(normalizedBytes(expectedPrevious))) throw invalid();
    if (previousIndex >= 0) await readPoint(files, commits, previousIndex);
  }
  return { entry, current };
}

export async function inspectProjectRecovery(files: ProjectFiles) {
  const commits = await readCommitChain(files), head = commits.at(-1);
  if (!head) throw invalid();
  await readCompatibleEntry(files, commits, head.record.projectId);
  const report = { projectId: head.record.projectId, currentSavePointId: head.record.savePointId,
    currentCommitSequence: head.record.commitSequence, currentCommitSha256: head.digest,
    previousSavePointId: null as string | null, previousEditorSequence: null as number | null };
  const damaged = (error: unknown) => error instanceof StorageIOError ? error.errno === 2 :
    error instanceof HostError && ["PROJECT_INVALID", "REFERENCE_INVALID", "INVALID_ARGUMENT"].includes(error.code);
  try { await readPoint(files, commits, commits.length - 1); return { ...report, status: "healthy" as const }; }
  catch (error) { if (!damaged(error)) throw error; }
  const previousIndex = retainedPrevious(commits);
  if (previousIndex >= 0) {
    try {
      const previous = await readPoint(files, commits, previousIndex);
      return { ...report, status: "previous_available" as const, previousSavePointId: previous.savePointId, previousEditorSequence: previous.editorSequence };
    } catch (error) { if (!damaged(error)) throw error; }
  }
  return { ...report, status: "no_valid_previous" as const };
}

async function resolveRecovery(files: ProjectFiles, projectId: string, choice: RecoveryChoice) {
  const report = await inspectProjectRecovery(files);
  if (report.projectId !== projectId || report.status !== "previous_available" || report.currentSavePointId !== choice.currentSavePointId ||
      report.currentCommitSequence !== choice.currentCommitSequence || report.currentCommitSha256 !== choice.currentCommitSha256 ||
      report.previousSavePointId !== choice.previousSavePointId) {
    throw new HostError("REFERENCE_STALE", 409, "Recovery options changed. Inspect the project again before confirming.");
  }
  const commits = await readCommitChain(files, projectId);
  return { head: commits.at(-1)!, previous: commits[retainedPrevious(commits)],
    manifest: await readPoint(files, commits, retainedPrevious(commits)) };
}

export function prepareRecovery(files: ProjectFiles, projectId: string): Prepare {
  return async (_current, save) => {
    const { manifest } = await resolveRecovery(files, projectId, recoveryChoice.parse(save.request));
    return { roots: manifest.roots, objects: manifest.objects, editorSnapshotId: manifest.editorSnapshotId, editorSequence: manifest.editorSequence };
  };
}

export async function createProjectCommits(files: ProjectFiles, projectId: string, confirmedRecovery?: RecoveryChoice) {
  for (const directory of ["saves/commits", "saves/points", "saves/requests", "staging/saves"]) await files.mkdir(directory);
  let current: Manifest | null = null;
  let entry: Entry | null = null;
  let recovering: Awaited<ReturnType<typeof resolveRecovery>> | null = null;
  let blocked = false;
  let tail: Promise<void> = Promise.resolve();
  const requests = new Map<string, Save>();
  const keys = new Map<string, string>();
  let requestSequence = 0;
  const keyFor = (save: Pick<Save, "route" | "subject" | "idempotencyKey">) => JSON.stringify([save.route, save.subject, save.idempotencyKey]);
  const pathFor = (saveId: string) => `saves/requests/${encodeId(saveId)}.json`;
  const serialize = <T>(action: () => Promise<T>) => {
    const result = tail.then(action);
    tail = result.then(() => {}, () => {});
    return result;
  };
  const persistSave = async (save: Save) => {
    if (jsonBytes(save).length > 64 * 1024 * 1024) throw new HostError("RESOURCE_LIMIT_EXCEEDED", 400, "The durable save request exceeds its size limit.");
    await files.writeJson(pathFor(save.saveId), saveRecord.parse(save), requests.has(save.saveId));
    requests.set(save.saveId, save);
    keys.set(keyFor(save), save.saveId);
  };
  const recover = async () => {
    const commits = await readCommitChain(files, projectId);
    const oldEntry = await readCompatibleEntry(files, commits, projectId);
    if (!commits.length) {
      if (oldEntry) throw invalid();
      current = null; entry = null;
      return;
    }
    const head = commits[commits.length - 1];
    const manifest = await readPoint(files, commits, commits.length - 1);
    // A migrated project may intentionally carry only its current complete point.
    const previousIndex = oldEntry?.current.savePointId === head.record.savePointId && oldEntry.previous === null
      ? -1 : retainedPrevious(commits);
    const next: Entry = { schemaVersion: 1, projectId, entryRevision: head.record.commitSequence,
      current: pointReference(head), previous: previousIndex >= 0 ? pointReference(commits[previousIndex]) : null };
    // Readable bytes may come from a rename whose directory sync failed.
    // Re-establish durability before publishing an entry or a success receipt.
    for (const object of manifest.objects) await files.sync(object.path);
    await files.sync(head.record.manifest.path);
    for (const item of commits) await files.sync(item.path);
    if (!oldEntry || !jsonBytes(oldEntry).equals(jsonBytes(next))) await files.writeJson("project.json", next, true);
    const readback = entryRecord.parse(JSON.parse((await files.read("project.json")).toString("utf8")));
    if (!jsonBytes(readback).equals(jsonBytes(next))) throw invalid();
    await files.sync("project.json");
    entry = next; current = manifest; recovering = null;
    for (const item of commits) {
      const save = requests.get(item.record.saveId);
      if (save && save.savePointId !== item.record.savePointId) throw conflict();
      if (save && save.status !== "succeeded") await persistSave({ ...save, status: "succeeded", error: undefined });
    }
    const recoverySave = head.record.recoveredFromSavePointId ? requests.get(head.record.saveId) : undefined;
    if (recoverySave) for (const save of requests.values()) {
      if (save.requestSequence < recoverySave.requestSequence && ["queued", "writing"].includes(save.status)) {
        await persistSave({ ...save, status: "failed", error: { code: "RECOVERY_SUPERSEDED", message: "This pending save was superseded by the confirmed recovery point." } });
      }
    }
  };
  const acceptedSequences = new Set<number>();
  for (const filename of await files.list("saves/requests")) {
    if (!filename.endsWith(".json")) continue;
    const save = saveRecord.parse(JSON.parse((await files.read(`saves/requests/${filename}`)).toString("utf8")));
    if (save.projectId !== projectId || pathFor(save.saveId) !== `saves/requests/${filename}` || keys.has(keyFor(save)) || acceptedSequences.has(save.requestSequence) ||
        save.requestDigest !== sha256(normalizedBytes({ route: save.route, subject: save.subject, request: save.request,
          editorSnapshotId: save.editorSnapshotId, editorSequence: save.editorSequence }))) throw conflict();
    await files.sync(`saves/requests/${filename}`);
    acceptedSequences.add(save.requestSequence);
    requests.set(save.saveId, save); keys.set(keyFor(save), save.saveId);
    requestSequence = Math.max(requestSequence, save.requestSequence);
  }
  try { await recover(); }
  catch (error) {
    const pendingRecovery = [...requests.values()].filter(save => save.route === "project-recovery" && ["queued", "writing"].includes(save.status));
    if (pendingRecovery.length > 1) throw conflict();
    const choice = confirmedRecovery ?? pendingRecovery[0]?.request;
    if (!choice) throw error;
    recovering = await resolveRecovery(files, projectId, recoveryChoice.parse(choice));
    entry = { schemaVersion: 1, projectId, entryRevision: recovering.head.record.commitSequence,
      current: pointReference(recovering.head), previous: pointReference(recovering.previous) };
  }

  const perform = async (save: Save, prepare: Prepare) => {
    if (blocked || ["succeeded", "failed"].includes(requests.get(save.saveId)?.status ?? "")) return;
    if (recovering && save.route !== "project-recovery") return;
    let committing = false;
    try {
      save = { ...save, status: "writing", error: undefined };
      await persistSave(save);
      const candidate = await prepare(current, save);
      const manifest = manifestRecord.parse({ ...candidate, schemaVersion: 1, projectId, savePointId: save.savePointId,
        saveId: save.saveId, createdAt: save.createdAt, previousSavePointId: recovering?.head.record.savePointId ?? current?.savePointId ?? null });
      manifest.objects = await retainProjectClosure(files, manifest);
      if (save.editorSnapshotId !== null && (manifest.editorSnapshotId !== save.editorSnapshotId || manifest.editorSequence !== save.editorSequence)) throw invalid();
      await verifyManifest(files, manifest);
      const directory = `saves/points/${encodeId(save.savePointId)}`;
      await files.mkdir(directory);
      const manifestPath = `${directory}/manifest.json`, bytes = jsonBytes(manifest);
      try { await files.writeJson(manifestPath, manifest); }
      catch (error) {
        if (!(error instanceof StorageIOError) || error.errno !== 17 || !(await files.read(manifestPath)).equals(bytes)) throw error;
      }
      const sequence = (entry?.current.commitSequence ?? 0) + 1;
      const record = commitRecord.parse({ schemaVersion: 1, projectId, commitSequence: sequence, previousCommitSequence: sequence - 1,
        saveId: save.saveId, savePointId: save.savePointId, manifest: { path: manifestPath, sizeBytes: bytes.length, sha256: sha256(bytes) }, createdAt: save.createdAt,
        ...(save.route === "project-recovery" ? { recoveredFromSavePointId: recoveryChoice.parse(save.request).previousSavePointId } : {}) });
      committing = true;
      await files.writeJson(commitPath(sequence, save.savePointId), record);
      await recover();
      if (current && entry) await collectProjectGarbage(files, current, entry, [...requests.values()]);
    } catch (error) {
      if (committing) {
        try {
          await recover();
          if (requests.get(save.saveId)?.status === "succeeded") return;
        } catch { /* Keep the accepted request unresolved until storage can be reconciled. */ }
        blocked = true;
        return;
      }
      try {
        await persistSave({ ...save, status: "failed", error: { code: error instanceof HostError ? error.code : "SAVE_FAILED",
          message: error instanceof HostError ? error.message : "The previous complete save point was preserved." } });
      } catch { blocked = true; }
    }
  };
  return {
    current: () => current === null ? null : structuredClone(current),
    entry: () => entry === null ? null : structuredClone(entry),
    state: () => ({ blocked: blocked || recovering !== null, pending: [...requests.values()].filter(save => save.status === "queued" || save.status === "writing").length }),
    async accept(input: AcceptedRequest, prepare: Prepare, validate?: (current: Manifest | null, pending: Save[]) => void) {
      const accepted = await serialize(async () => {
        if (blocked) throw new HostError("PROJECT_WRITE_LOCKED", 409, "Resolve the previous save outcome before writing.");
        const requestDigest = sha256(normalizedBytes({ route: input.route, subject: input.subject, request: input.request,
          editorSnapshotId: input.editorSnapshotId, editorSequence: input.editorSequence }));
        const existingId = keys.get(keyFor(input));
        if (existingId) {
          const existing = requests.get(existingId)!;
          if (existing.requestDigest !== requestDigest) throw new HostError("IDEMPOTENCY_KEY_REUSED", 409, "The idempotency key was already used with different content.");
          return { save: structuredClone(existing), replayed: true };
        }
        if (recovering) {
          if (input.route !== "project-recovery" || input.subject !== projectId ||
              [...requests.values()].some(save => save.route === "project-recovery" && ["queued", "writing"].includes(save.status))) {
            throw new HostError("PROJECT_WRITE_LOCKED", 409, "Complete the confirmed recovery before accepting other writes.");
          }
          await resolveRecovery(files, projectId, recoveryChoice.parse(input.request));
        } else if (input.route === "project-recovery") {
          throw new HostError("REFERENCE_STALE", 409, "The current project point no longer requires recovery.");
        }
        validate?.(current, [...requests.values()].filter(save => save.status === "queued" || save.status === "writing"));
        const save = saveRecord.parse({ ...input, schemaVersion: 1, projectId, saveId: randomUUID(), savePointId: randomUUID(),
          requestDigest, requestSequence: ++requestSequence, status: "queued", createdAt: new Date().toISOString() });
        try { await persistSave(save); }
        catch (error) { blocked = true; throw error; }
        return { save: structuredClone(save), replayed: false };
      });
      if (!accepted.replayed) void serialize(() => perform(accepted.save, prepare));
      return accepted;
    },
    get(saveId: string) {
      const save = requests.get(saveId);
      if (!save) throw new HostError("SAVE_NOT_FOUND", 404, "Save request not found.");
      return structuredClone(save);
    },
    requests: () => [...requests.values()].map(save => structuredClone(save)),
    maintain<T>(action: (manifest: Manifest, locator: Entry, saves: Save[]) => Promise<T>) {
      return serialize(async () => {
        if (blocked || recovering || !current || !entry) throw new HostError("PROJECT_WRITE_LOCKED", 409, "Resolve the current save before maintenance.");
        return action(structuredClone(current), structuredClone(entry), [...requests.values()].map(save => structuredClone(save)));
      });
    },
    pending: () => [...requests.values()].filter(save => save.status === "queued" || save.status === "writing")
      .sort((a, b) => Number(b.route === "project-recovery") - Number(a.route === "project-recovery") || a.requestSequence - b.requestSequence).map(save => structuredClone(save)),
    resume(saveId: string, prepare: Prepare) {
      const save = requests.get(saveId);
      if (!save || !["queued", "writing"].includes(save.status)) return tail;
      return serialize(() => perform(save, prepare));
    },
    stopWrites() { blocked = true; },
    drain: () => tail,
  };
}
