import { createHash, randomUUID } from "node:crypto";
import { lstat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Writable, type Readable } from "node:stream";
import { z } from "zod";
import { HostError } from "../sessions.ts";
import { openProjectFiles, StorageIOError } from "./files.ts";
import { validateImportedProject } from "./commits.ts";
import { openProjectPackage, writeProjectPackage, packageManifestRecord, type PackageManifest } from "./project-package.ts";
import { exportPublicationRecord, type ExportPublication } from "./records.ts";
import { verifyObject } from "./objects.ts";

function targetName(value: string) {
  const name = value.normalize("NFC");
  const reserved = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
  if (!name || name === "." || name === ".." || Buffer.byteLength(name) > 200 || name.endsWith(".") || name.endsWith(" ") ||
      reserved.has(name.split(".")[0].toUpperCase()) || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || '/\\:*?"<>|'.includes(char))) {
    throw new HostError("INVALID_ARGUMENT", 400, "Choose a valid destination name.");
  }
  return name;
}

async function prepareDestination(parent: string, name: string, executable: string, requiredBytes: bigint) {
  const files = await openProjectFiles(parent, executable), path = join(files.directory, name);
  try { await lstat(path); throw new HostError("TARGET_NOT_EMPTY", 409, "The destination already exists."); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
  const space = await statfs(files.directory, { bigint: true });
  if (space.bavail * space.bsize < requiredBytes) throw new HostError("INSUFFICIENT_SPACE", 422, "The destination has insufficient available space.");
  return files;
}

async function publish(files: Awaited<ReturnType<typeof openProjectFiles>>, temporary: string, name: string) {
  try { await files.publish(temporary, name); }
  catch (error) {
    if (error instanceof StorageIOError && error.errno === 17) throw new HostError("TARGET_NOT_EMPTY", 409, "The destination already exists.");
    throw error;
  }
}

async function validatePackageProject(files: Awaited<ReturnType<typeof openProjectFiles>>, manifest: PackageManifest) {
  try { await validateImportedProject(files, manifest.projectId, manifest.savePointId); }
  catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError || (error instanceof HostError && ["PROJECT_INVALID", "SAVE_CHAIN_CONFLICT"].includes(error.code))) {
      throw new HostError("PACKAGE_INTEGRITY_FAILED", 422, "The imported project records or references are incomplete.");
    }
    throw error;
  }
}

// A durable receipt precedes publication. Reconcile its exact bytes after an unknown outcome.
export async function finishExportPublication(value: ExportPublication, executable: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const receipt = exportPublicationRecord.parse(value), name = targetName(receipt.name);
  if (receipt.temporary.includes("/") || receipt.temporary.includes("\\") ||
      !receipt.temporary.startsWith(`.${name}.autocut-export-`)) throw new HostError("PROJECT_INVALID", 409, "Invalid export publication receipt.");
  const files = await openProjectFiles(receipt.parent, executable);
  const matches = async (path: string) => {
    let size = 0;
    const hash = createHash("sha256");
    const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
      if (signal?.aborted) return callback(new HostError("TASK_CANCELLED", 409, "Project export was cancelled."));
      size += chunk.length;
      if (size > receipt.sizeBytes) return callback(new HostError("TARGET_NOT_EMPTY", 409, "The export destination contains different bytes."));
      hash.update(chunk); callback();
    } });
    try { await files.copyTo(path, output); }
    catch (error) { if (error instanceof StorageIOError && error.errno === 2) return false; throw error; }
    if (size !== receipt.sizeBytes || hash.digest("hex") !== receipt.sha256) throw new HostError("TARGET_NOT_EMPTY", 409, "The export destination contains different bytes.");
    return true;
  };
  if (await matches(name)) return { name, sizeBytes: receipt.sizeBytes, sha256: receipt.sha256, replayed: true };
  if (!await matches(receipt.temporary)) throw new HostError("EXPORT_OUTPUT_MISSING", 409, "The verified export output is no longer available.");
  signal?.throwIfAborted();
  await publish(files, receipt.temporary, name);
  return { name, sizeBytes: receipt.sizeBytes, sha256: receipt.sha256, replayed: false };
}

// The caller owns the durable export pin until this operation has stopped all readers.
export async function exportProjectPackage(parent: string, requestedName: string, executable: string,
  source: { manifest: PackageManifest; source(path: string): Readable },
  beforePublish?: (receipt: ExportPublication) => Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const name = targetName(requestedName.endsWith(".autocut-project") ? requestedName : `${requestedName}.autocut-project`);
  const required = source.manifest.entries.reduce((sum, entry) => sum + BigInt(entry.sizeBytes) + BigInt(Buffer.byteLength(entry.path) * 2 + 256), 0n)
    + BigInt(Buffer.byteLength(JSON.stringify(source.manifest))) + 1024n;
  const files = await prepareDestination(parent, name, executable, required);
  const temporary = `.${name}.autocut-export-${randomUUID()}`;
  const archive = await writeProjectPackage(files, temporary, source.manifest, source.source, signal);
  const zip = await openProjectPackage(archive.sizeBytes, (start, length) => files.stream(temporary, start, length));
  try { await zip.verify(signal); } finally { zip.close(); }
  await beforePublish?.({ parent: files.directory, temporary, name, sizeBytes: archive.sizeBytes, sha256: archive.sha256 });
  signal?.throwIfAborted();
  await publish(files, temporary, name);
  return { name, sizeBytes: archive.sizeBytes, sha256: archive.sha256, projectId: source.manifest.projectId, savePointId: source.manifest.savePointId };
}

export async function importProjectPackage(parent: string, requestedName: string, executable: string,
  source: { sizeBytes: number; readRange(start: number, length: number): Readable; verify(): Promise<void> },
  beforePublish?: (receipt: ImportPublication) => Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const name = targetName(requestedName);
  const zip = await openProjectPackage(source.sizeBytes, source.readRange);
  try {
    const required = BigInt(zip.totalBytes) + BigInt(zip.manifest.entries.length) * 4096n;
    const files = await prepareDestination(parent, name, executable, required);
    const temporary = `.${name}.autocut-import-${randomUUID()}`;
    await files.mkdir(temporary);
    const target = await openProjectFiles(join(files.directory, temporary), executable);
    await zip.extract(target, signal);
    await source.verify();
    await validatePackageProject(target, zip.manifest);
    await beforePublish?.({ parent: files.directory, temporary, name, manifest: zip.manifest });
    signal?.throwIfAborted();
    await publish(files, temporary, name);
    return { name, directory: join(files.directory, name), projectId: zip.manifest.projectId, savePointId: zip.manifest.savePointId };
  } finally { zip.close(); }
}

export const importPublicationRecord = z.strictObject({ parent: z.string().min(1), temporary: z.string().min(1), name: z.string().min(1), manifest: packageManifestRecord });
export type ImportPublication = z.infer<typeof importPublicationRecord>;

export async function finishImportPublication(value: ImportPublication, executable: string, signal?: AbortSignal) {
  const receipt = importPublicationRecord.parse(value), name = targetName(receipt.name);
  if (receipt.temporary.includes("/") || receipt.temporary.includes("\\") || !receipt.temporary.startsWith(`.${name}.autocut-import-`)) {
    throw new HostError("PROJECT_INVALID", 409, "Invalid import publication receipt.");
  }
  const parent = await openProjectFiles(receipt.parent, executable);
  let published = true;
  try { await lstat(join(parent.directory, name)); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; published = false; }
  const directory = join(parent.directory, published ? name : receipt.temporary);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HostError("TARGET_NOT_EMPTY", 409, "The import destination is not the verified project directory.");
  const files = await openProjectFiles(directory, executable);
  for (const entry of receipt.manifest.entries) {
    signal?.throwIfAborted();
    if (!entry.path.startsWith("project/")) throw new HostError("PROJECT_INVALID", 409, "Invalid imported file path.");
    await verifyObject(files, { ...entry, path: entry.path.slice("project/".length) });
  }
  await validatePackageProject(files, receipt.manifest);
  if (!published) { signal?.throwIfAborted(); await publish(parent, receipt.temporary, name); }
  return { name, directory: join(parent.directory, name), projectId: receipt.manifest.projectId, savePointId: receipt.manifest.savePointId, replayed: published };
}
