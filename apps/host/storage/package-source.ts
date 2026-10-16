import { Readable } from "node:stream";
import { HostError } from "../sessions.ts";
import type { ProjectFiles } from "./files.ts";
import { readMigrationPin } from "./migration-pins.ts";
import { commitPath, commitRecord, entryRecord, jsonBytes, sha256 } from "./records.ts";
import { packageManifestRecord } from "./project-package.ts";

// Read only the immutable records fixed by the durable pin; never copy the live entry.
export async function preparePackageSource(files: ProjectFiles, projectId: string, exportId: string, appVersion: string) {
  const pin = await readMigrationPin(files, projectId, exportId);
  if (pin.status !== "active") throw new HostError("EXPORT_FINISHED", 409, "This export no longer holds its source objects.");
  const invalid = () => new HostError("PROJECT_INVALID", 409, "The pinned project records are inconsistent.");
  const entry = entryRecord.parse({ schemaVersion: 1, projectId, entryRevision: pin.point.commitSequence,
    current: pin.point, previous: pin.previous?.point ?? null });
  const entryBytes = jsonBytes(entry);
  const records = new Map<string, { path: string; sizeBytes: number; sha256: string }>();
  const add = (object: { path: string; sizeBytes: number; sha256: string }) => {
    const existing = records.get(object.path);
    if (existing && (existing.sizeBytes !== object.sizeBytes || existing.sha256 !== object.sha256)) throw invalid();
    records.set(object.path, { path: object.path, sizeBytes: object.sizeBytes, sha256: object.sha256 });
  };
  add({ path: "project.json", sizeBytes: entryBytes.length, sha256: sha256(entryBytes) });
  for (const object of pin.objects) {
    if (!["data", "media", "resources"].includes(object.path.split("/")[0])) throw invalid();
    add(object);
  }
  add(pin.manifest);
  if (pin.previous) add(pin.previous.manifest);
  const chain = [];
  for (const name of await files.list("saves/commits")) {
    if (!name.endsWith(".json")) continue;
    const path = `saves/commits/${name}`, bytes = await files.read(path);
    const commit = commitRecord.parse(JSON.parse(bytes.toString("utf8")));
    if (commit.commitSequence > pin.point.commitSequence) continue;
    if (commit.projectId !== projectId || path !== commitPath(commit.commitSequence, commit.savePointId)) throw invalid();
    const descriptor = { path, sizeBytes: bytes.length, sha256: sha256(bytes) };
    for (const held of [{ point: pin.point, manifest: pin.manifest }, ...(pin.previous ? [pin.previous] : [])]) {
      if (held.point.commitSequence !== commit.commitSequence) continue;
      if (held.point.commitPath !== path || held.point.commitSha256 !== descriptor.sha256 || held.point.savePointId !== commit.savePointId ||
          held.manifest.path !== commit.manifest.path || held.manifest.sha256 !== commit.manifest.sha256 || held.manifest.sizeBytes !== commit.manifest.sizeBytes) throw invalid();
    }
    add(descriptor); chain.push(commit);
  }
  chain.sort((a, b) => a.commitSequence - b.commitSequence);
  const points = new Set<string>(), saves = new Set<string>();
  if (chain.length !== pin.point.commitSequence) throw invalid();
  for (const [index, commit] of chain.entries()) {
    if (commit.commitSequence !== index + 1 || commit.previousCommitSequence !== index || points.has(commit.savePointId) || saves.has(commit.saveId) ||
        (commit.recoveredFromSavePointId && !points.has(commit.recoveredFromSavePointId))) throw invalid();
    points.add(commit.savePointId); saves.add(commit.saveId);
  }
  const manifest = packageManifestRecord.parse({ schemaVersion: 1, format: "autocut-project", appVersion, projectSchemaVersion: 1,
    projectId, savePointId: pin.savePointId, createdAt: pin.createdAt,
    entries: [...records.values()].map(object => ({ ...object, path: `project/${object.path}` })) });
  return { manifest, source(path: string) {
    if (!path.startsWith("project/")) throw invalid();
    const relative = path.slice("project/".length), object = records.get(relative);
    if (!object) throw invalid();
    return relative === "project.json" ? Readable.from([entryBytes]) : files.stream(relative, 0, object.sizeBytes);
  } };
}
