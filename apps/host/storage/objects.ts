import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { HostError } from "../sessions.ts";
import { type ProjectFiles, StorageIOError } from "./files.ts";
import { jsonBytes, sha256, type ObjectRecord, type ObjectReference } from "./records.ts";

export async function verifyObject(files: ProjectFiles, object: Pick<ObjectRecord, "path" | "sizeBytes" | "sha256">) {
  let size = 0;
  const hash = createHash("sha256");
  const invalid = () => new HostError("PROJECT_INVALID", 409, "Project object bytes differ from the saved identity.");
  await files.copyTo(object.path, new Writable({ write(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    if (size > object.sizeBytes) return callback(invalid());
    hash.update(chunk);
    callback();
  } }));
  if (size !== object.sizeBytes || hash.digest("hex") !== object.sha256) throw invalid();
}

export async function writeObject(files: ProjectFiles, reference: ObjectReference, path: string, value: unknown): Promise<ObjectRecord> {
  await files.mkdir(path.slice(0, path.lastIndexOf("/")));
  const bytes = jsonBytes(value);
  if (bytes.length > 64 * 1024 * 1024) throw new HostError("RESOURCE_LIMIT_EXCEEDED", 400, "Project object exceeds its size limit.");
  try { await files.writeJson(path, value); }
  catch (error) {
    if (!(error instanceof StorageIOError) || error.errno !== 17 || !(await files.read(path)).equals(bytes)) throw error;
  }
  return { ...reference, path, sizeBytes: bytes.length, sha256: sha256(bytes) };
}
