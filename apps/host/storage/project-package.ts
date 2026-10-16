import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { z } from "zod";
import { ZipFile as ZipWriter } from "yazl";
import { RandomAccessReader, fromRandomAccessReaderPromise, type Entry } from "yauzl";
import { HostError } from "../sessions.ts";
import type { ProjectFiles } from "./files.ts";
import { jsonBytes, objectRecord } from "./records.ts";

const MAX_ENTRIES = 100_000, MAX_METADATA = 64 * 1024 * 1024;
const invalid = (message: string) => new HostError("PACKAGE_INTEGRITY_FAILED", 422, message);
const reserved = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
function validPath(path: string) {
  if (!path || Buffer.byteLength(path) > 4096 || path.includes("\\")) throw invalid("Invalid package path.");
  for (const part of path.split("/")) {
    if (!part || part === "." || part === ".." || Buffer.byteLength(part) > 255 || part.endsWith(".") || part.endsWith(" ") ||
        reserved.has(part.split(".")[0].toUpperCase()) || [...part].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || '<>:"|?*'.includes(char))) {
      throw invalid("Package path is not portable or safe.");
    }
  }
  return path.normalize("NFC").toLowerCase();
}

const packageEntry = objectRecord.pick({ path: true, sizeBytes: true, sha256: true });
export const packageManifestRecord = z.strictObject({ schemaVersion: z.literal(1), format: z.literal("autocut-project"),
  appVersion: z.string().min(1).max(64), projectSchemaVersion: z.literal(1), projectId: z.string().min(1).max(256),
  savePointId: z.string().min(1).max(256), createdAt: z.iso.datetime(), entries: z.array(packageEntry).max(MAX_ENTRIES - 1) });
export type PackageManifest = z.infer<typeof packageManifestRecord>;

function validateManifest(value: unknown) {
  if (value && typeof value === "object" && (("schemaVersion" in value && value.schemaVersion !== 1) ||
      ("projectSchemaVersion" in value && value.projectSchemaVersion !== 1))) {
    throw new HostError("PACKAGE_VERSION_UNSUPPORTED", 422, "This project package version is unsupported.");
  }
  const parsed = packageManifestRecord.safeParse(value);
  if (!parsed.success) throw invalid("The package manifest is invalid.");
  const manifest = parsed.data, names = new Set<string>();
  let total = 0;
  for (const entry of manifest.entries) {
    const name = validPath(entry.path);
    if (!entry.path.startsWith("project/") || names.has(name)) throw invalid("Package manifest paths conflict.");
    const path = entry.path.slice("project/".length);
    if (path !== "project.json" && !["data/", "media/", "resources/", "saves/commits/", "saves/points/"].some(prefix => path.startsWith(prefix))) {
      throw invalid("Package contains machine-local or unsupported project files.");
    }
    names.add(name); total += entry.sizeBytes;
    if (!Number.isSafeInteger(total) || (entry.path.endsWith(".json") && entry.sizeBytes > MAX_METADATA)) throw invalid("Package data exceeds its supported limits.");
  }
  if (!names.has("project/project.json")) throw invalid("The package has no project entry.");
  if (jsonBytes(manifest).length > MAX_METADATA) throw invalid("Package manifest exceeds its size limit.");
  return { manifest, total };
}

function verifiedStream(input: Readable, expected: { sizeBytes: number; sha256: string }) {
  return Readable.from((async function* () {
    let count = 0;
    const hash = createHash("sha256");
    try {
      for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        count += bytes.length;
        if (count > expected.sizeBytes) throw invalid("A package entry exceeds its declared size.");
        hash.update(bytes); yield bytes;
      }
      if (count !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) throw invalid("A package entry failed its content check.");
    } catch (error) { throw error instanceof HostError ? error : invalid("A package entry could not be decoded or read completely."); }
    finally { input.destroy(); await finished(input).catch(() => {}); }
  })());
}

export async function writeProjectPackage(files: ProjectFiles, path: string, value: PackageManifest, source: (path: string) => Readable, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { manifest } = validateManifest(value), zip = new ZipWriter(), active = new Set<Readable>();
  let sizeBytes = 0;
  const hash = createHash("sha256");
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    sizeBytes += chunk.length;
    if (!Number.isSafeInteger(sizeBytes)) return callback(invalid("Package exceeds the supported size range."));
    hash.update(chunk); callback(null, chunk);
  } });
  zip.on("error", error => meter.destroy(error));
  zip.outputStream.on("error", error => meter.destroy(error));
  zip.outputStream.pipe(meter);
  const abort = () => meter.destroy(new HostError("TASK_CANCELLED", 409, "Project export was cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  const writing = files.write(path, meter);
  void writing.catch(() => {});
  try {
    zip.addBuffer(jsonBytes(manifest), "package-manifest.json", { compress: false, mode: 0o100600 });
    for (const entry of manifest.entries) zip.addReadStreamLazy(entry.path, { compress: false, size: entry.sizeBytes, mode: 0o100600 }, done => {
      if (meter.destroyed) { done(new Error("Package writing stopped.")); return; }
      try {
        const stream = verifiedStream(source(entry.path), entry);
        active.add(stream); stream.once("close", () => active.delete(stream));
        stream.once("error", error => meter.destroy(error));
        done(null, stream);
      } catch (error) { done(error instanceof Error ? error : new Error("Package source could not be read.")); }
    });
    zip.end({ forceZip64Format: true });
    await writing;
    return { path, sizeBytes, sha256: hash.digest("hex") };
  } catch (error) {
    meter.destroy(error instanceof Error ? error : invalid("Package writing failed."));
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    zip.outputStream.unpipe(meter); zip.outputStream.destroy(); meter.destroy();
    await Promise.all([...active].map(async stream => { stream.destroy(); await finished(stream).catch(() => {}); }));
    await writing.catch(() => {});
  }
}

export async function openProjectPackage(size: number, readRange: (start: number, length: number) => Readable) {
  if (!Number.isSafeInteger(size) || size < 22) throw invalid("Invalid package file size.");
  let sourceFailure: Error | undefined;
  const failure = (error: unknown) => sourceFailure ?? (error instanceof HostError ? error : invalid("The project archive is malformed or damaged."));
  class Reader extends RandomAccessReader {
    _readStreamForRange(start: number, end: number) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > size || end <= start) throw invalid("Package byte range is invalid.");
      const input = readRange(start, end - start);
      input.once("error", error => { sourceFailure = error; });
      return input;
    }
  }
  const zip = await fromRandomAccessReaderPromise(new Reader(), size, { autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }).catch(error => { throw failure(error); });
  try {
    if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount > MAX_ENTRIES) throw invalid("Package entry count exceeds its limit.");
    const entries = new Map<string, Entry>(), names = new Set<string>();
    let metadata = 0;
    for await (const entry of zip.eachEntry()) {
      const name = validPath(entry.fileName), mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      metadata += 46 + entry.fileNameLength + entry.fileCommentLength + entry.extraFieldLength;
      if (names.has(name) || !Number.isSafeInteger(metadata) || metadata > MAX_METADATA || entries.size >= MAX_ENTRIES ||
          (mode !== 0 && mode !== 0o100000) || (entry.externalFileAttributes & 0x10) || (entry.generalPurposeBitFlag & 1) ||
          ![0, 8].includes(entry.compressionMethod) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
          !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 ||
          (entry.compressionMethod === 8 && entry.uncompressedSize > 0 && (!entry.compressedSize || entry.uncompressedSize / entry.compressedSize > 1000))) {
        throw invalid("Package contains unsupported or conflicting entries.");
      }
      names.add(name); entries.set(entry.fileName, entry);
    }
    const description = entries.get("package-manifest.json");
    if (!description || description.uncompressedSize > MAX_METADATA) throw invalid("Package manifest is missing or too large.");
    const chunks: Buffer[] = []; let length = 0;
    const input = await zip.openReadStreamPromise(description);
    try {
      for await (const chunk of input) {
        length += chunk.length;
        if (length > MAX_METADATA) throw invalid("Package manifest exceeds its size limit.");
        chunks.push(chunk);
      }
    } finally { input.destroy(); }
    const { manifest, total } = validateManifest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (entries.size !== manifest.entries.length + 1) throw invalid("Package entries differ from the declared manifest.");
    for (const expected of manifest.entries) {
      const entry = entries.get(expected.path);
      if (!entry || entry.uncompressedSize !== expected.sizeBytes) throw invalid("A declared package file is missing or has a different size.");
    }
    return { manifest, totalBytes: total,
      async verify(signal?: AbortSignal) {
        for (const expected of manifest.entries) {
          signal?.throwIfAborted();
          const stream = verifiedStream(await zip.openReadStreamPromise(entries.get(expected.path)!).catch(error => { throw failure(error); }), expected);
          for await (const chunk of stream) { signal?.throwIfAborted(); void chunk; }
        }
      },
      async extract(target: ProjectFiles, signal?: AbortSignal) {
        for (const expected of manifest.entries) {
          signal?.throwIfAborted();
          const path = expected.path.slice("project/".length), slash = path.lastIndexOf("/");
          if (slash >= 0) await target.mkdir(path.slice(0, slash));
          const stream = verifiedStream(await zip.openReadStreamPromise(entries.get(expected.path)!).catch(error => { throw failure(error); }), expected);
          const abort = () => stream.destroy(new HostError("TASK_CANCELLED", 409, "Project import was cancelled."));
          signal?.addEventListener("abort", abort, { once: true });
          try { signal?.throwIfAborted(); await target.write(path, stream); }
          finally { signal?.removeEventListener("abort", abort); stream.destroy(); await finished(stream).catch(() => {}); }
        }
      },
      close() { zip.close(); },
    };
  } catch (error) { zip.close(); throw failure(error); }
}
