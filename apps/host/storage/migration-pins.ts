import { z } from "zod";
import { HostError } from "../sessions.ts";
import { type ProjectFiles, StorageIOError } from "./files.ts";
import { commitRecord, encodeId, entryRecord, manifestRecord, normalizedBytes, objectRecord, referenceKey, sha256,
  exportPublicationRecord, type ExportPublication, type Entry, type Manifest } from "./records.ts";

export const migrationPinRecord = z.strictObject({ schemaVersion: z.literal(1), projectId: z.string().min(1), exportId: z.string().min(1).max(256),
  savePointId: z.string().min(1), point: entryRecord.shape.current, manifest: commitRecord.shape.manifest,
  previous: z.strictObject({ point: entryRecord.shape.current, manifest: commitRecord.shape.manifest }).nullable(),
  objects: z.array(objectRecord).max(100_000), createdAt: z.iso.datetime(), status: z.enum(["active", "released"]),
  outcome: z.enum(["completed", "abandoned"]).optional(), releasedAt: z.iso.datetime().optional(),
  publication: exportPublicationRecord.optional(),
  requestDigest: z.string().length(64).optional(),
}).refine(value => value.savePointId === value.point.savePointId &&
  value.manifest.path === `saves/points/${encodeId(value.savePointId)}/manifest.json` &&
  (!value.previous || (value.previous.point.commitSequence < value.point.commitSequence &&
    value.previous.manifest.path === `saves/points/${encodeId(value.previous.point.savePointId)}/manifest.json`)) &&
  new Set(value.objects.map(referenceKey)).size === value.objects.length &&
  new Set(value.objects.map(object => object.path.toLowerCase())).size === value.objects.length &&
  (value.status === "active" ? !value.outcome && !value.releasedAt : Boolean(value.outcome && value.releasedAt)));

const pinPath = (exportId: string) => `refs/migrations/${encodeId(exportId)}.json`;

export async function readMigrationPin(files: ProjectFiles, projectId: string, exportId: string) {
  const pin = migrationPinRecord.parse(JSON.parse((await files.read(pinPath(exportId))).toString("utf8")));
  if (pin.projectId !== projectId || pin.exportId !== exportId) throw new HostError("PROJECT_INVALID", 409, "Migration pin identity changed.");
  return pin;
}

// The caller holds the project commit queue while fixing or releasing a pin.
export async function createMigrationPin(files: ProjectFiles, current: Manifest, entry: Entry, exportId: string, requestDigest?: string) {
  try {
    const existing = await readMigrationPin(files, current.projectId, exportId);
    if (existing.status !== "active") throw new HostError("EXPORT_FINISHED", 409, "Use a new export identity after completion or abandonment.");
    if (requestDigest !== undefined && existing.requestDigest !== requestDigest) throw new HostError("IDEMPOTENCY_CONFLICT", 409, "This export pin belongs to a different request.");
    return existing;
  } catch (error) { if (!(error instanceof StorageIOError) || error.errno !== 2) throw error; }
  const bytes = await files.read(entry.current.commitPath);
  if (sha256(bytes) !== entry.current.commitSha256) throw new HostError("PROJECT_INVALID", 409, "The export commit is damaged.");
  const commit = commitRecord.parse(JSON.parse(bytes.toString("utf8")));
  const content = await files.read(commit.manifest.path);
  const manifest = manifestRecord.parse(JSON.parse(content.toString("utf8")));
  if (entry.projectId !== current.projectId || commit.projectId !== current.projectId || commit.savePointId !== current.savePointId ||
      commit.commitSequence !== entry.current.commitSequence || commit.saveId !== current.saveId || content.length !== commit.manifest.sizeBytes ||
      sha256(content) !== commit.manifest.sha256 || !normalizedBytes(manifest).equals(normalizedBytes(current))) {
    throw new HostError("REFERENCE_STALE", 409, "The export save point changed before it could be pinned.");
  }
  let previous = null;
  const objects = new Map(current.objects.map(object => [referenceKey(object), object]));
  if (entry.previous) {
    const previousBytes = await files.read(entry.previous.commitPath);
    const previousCommit = commitRecord.parse(JSON.parse(previousBytes.toString("utf8")));
    const previousContent = await files.read(previousCommit.manifest.path);
    const previousManifest = manifestRecord.parse(JSON.parse(previousContent.toString("utf8")));
    if (sha256(previousBytes) !== entry.previous.commitSha256 || previousCommit.projectId !== current.projectId ||
        previousCommit.savePointId !== entry.previous.savePointId || previousCommit.commitSequence !== entry.previous.commitSequence ||
        previousContent.length !== previousCommit.manifest.sizeBytes || sha256(previousContent) !== previousCommit.manifest.sha256 ||
        previousManifest.projectId !== current.projectId || previousManifest.savePointId !== previousCommit.savePointId ||
        previousManifest.saveId !== previousCommit.saveId) throw new HostError("PROJECT_INVALID", 409, "The retained export point is damaged.");
    for (const object of previousManifest.objects) {
      const existing = objects.get(referenceKey(object));
      if (existing && !normalizedBytes(existing).equals(normalizedBytes(object))) throw new HostError("PROJECT_INVALID", 409, "Export points disagree about an immutable object.");
      objects.set(referenceKey(object), object);
    }
    previous = { point: entry.previous, manifest: previousCommit.manifest };
  }
  const pin = migrationPinRecord.parse({ schemaVersion: 1, projectId: current.projectId, exportId, savePointId: current.savePointId,
    point: entry.current, manifest: commit.manifest, previous, objects: [...objects.values()], createdAt: new Date().toISOString(), status: "active", requestDigest });
  await files.mkdir("refs/migrations");
  await files.writeJson(pinPath(exportId), pin);
  return pin;
}

// Persist the verified output before its rename, so a lost publication reply is recoverable.
export async function recordMigrationPublication(files: ProjectFiles, projectId: string, exportId: string, value: ExportPublication) {
  const publication = exportPublicationRecord.parse(value), pin = await readMigrationPin(files, projectId, exportId);
  if (pin.status !== "active") throw new HostError("EXPORT_FINISHED", 409, "This export has already ended.");
  if (pin.publication) {
    if (!normalizedBytes(pin.publication).equals(normalizedBytes(publication))) throw new HostError("REVISION_CONFLICT", 409, "The export already has a different verified output.");
    return pin;
  }
  const updated = migrationPinRecord.parse({ ...pin, publication });
  await files.writeJson(pinPath(exportId), updated, true);
  return updated;
}

// Readers must have stopped before the caller completes or explicitly abandons the export.
export async function releaseMigrationPin(files: ProjectFiles, projectId: string, exportId: string, outcome: "completed" | "abandoned") {
  const pin = await readMigrationPin(files, projectId, exportId);
  if (pin.status === "released") {
    if (pin.outcome !== outcome) throw new HostError("REVISION_CONFLICT", 409, "The export already ended with a different outcome.");
    return pin;
  }
  const released = migrationPinRecord.parse({ ...pin, status: "released", outcome, releasedAt: new Date().toISOString() });
  await files.writeJson(pinPath(exportId), released, true);
  return released;
}

export async function migrationProtection(files: ProjectFiles, projectId: string) {
  const paths = new Set<string>();
  let unresolved = false, names: string[];
  try { names = await files.list("refs/migrations"); }
  catch (error) { if (error instanceof StorageIOError && error.errno === 2) return { paths, unresolved }; throw error; }
  for (const name of names) {
    // Interrupted atomic writes and unknown records must not silently release protection.
    if (!name.endsWith(".json")) { unresolved = true; continue; }
    try {
      const pin = migrationPinRecord.parse(JSON.parse((await files.read(`refs/migrations/${name}`)).toString("utf8")));
      if (pin.projectId !== projectId || name !== `${encodeId(pin.exportId)}.json`) { unresolved = true; continue; }
      if (pin.status === "active") for (const object of pin.objects) paths.add(object.path);
    } catch { unresolved = true; }
  }
  return { paths, unresolved };
}
