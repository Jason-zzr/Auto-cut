import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { z } from "zod";
import { HostError } from "../sessions.ts";
import { type ProjectFiles, StorageIOError } from "./files.ts";
import { emptyRoots, encodeId, normalizedBytes, objectRecord, referenceKey, sha256, type Manifest, type Save } from "./records.ts";
import { inspectMedia } from "./media.ts";
import { verifyObject, writeObject } from "./objects.ts";

export const importMetadata = z.strictObject({ name: z.string().min(1).max(1024), mimeType: z.string().max(256),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const assetRecord = z.strictObject({ schemaVersion: z.literal(1), projectId: z.string(), assetId: z.string(), revision: z.number().int().positive().safe(),
  name: z.string(), kind: z.enum(["image", "video", "audio"]), mimeType: z.string(), sizeBytes: z.number().int().positive(), sha256: z.string(),
  mediaRef: z.strictObject({ kind: z.literal("media"), entityId: z.string(), blobId: z.string() }) });
export const receiptRecord = z.strictObject({ schemaVersion: z.literal(1), projectId: z.string(), metadata: importMetadata,
  importIdempotencyKey: z.string().min(1).max(128).optional(),
  registrationSourceSaveId: z.string().uuid().optional(),
  taskId: z.string().uuid(), stepId: z.string().uuid(), attemptId: z.string().uuid(), resultId: z.string().uuid(), artifactId: z.string().uuid(),
  stagingPath: z.string(), asset: assetRecord, media: objectRecord });
export type ImportMetadata = z.infer<typeof importMetadata>;

export async function receiveAsset(files: ProjectFiles, projectId: string, key: string, metadata: ImportMetadata, input: Readable) {
  const directory = `staging/imports/${encodeId(key)}`;
  await files.mkdir(directory);
  let previous: z.infer<typeof receiptRecord> | null = null;
  try { previous = receiptRecord.parse(JSON.parse((await files.read(`${directory}/received.json`)).toString("utf8"))); }
  catch (error) { if (!(error instanceof StorageIOError) || error.errno !== 2) throw error; }
  if (previous && (previous.projectId !== projectId || !normalizedBytes(previous.metadata).equals(normalizedBytes(metadata)))) {
    throw new HostError("IDEMPOTENCY_KEY_REUSED", 409, "This import key was used for different metadata.");
  }
  const stagingPath = `${directory}/${randomUUID()}.part`;
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    if (size > metadata.sizeBytes) return callback(new HostError("INVALID_ARGUMENT", 400, "Upload exceeds its declared size."));
    hash.update(chunk); callback(null, chunk);
  } });
  input.once("error", error => meter.destroy(error));
  input.pipe(meter);
  try { await files.write(stagingPath, meter); }
  finally { input.unpipe(meter); if (!input.readableEnded) input.destroy(); }
  if (size !== metadata.sizeBytes) throw new HostError("INVALID_ARGUMENT", 400, "Upload ended before its declared size.");
  const digest = hash.digest("hex");
  if (previous) {
    if (previous.media.sha256 !== digest || previous.media.sizeBytes !== size) throw new HostError("IDEMPOTENCY_KEY_REUSED", 409, "This import key was used for different media bytes.");
    // Only this verified retry copy is disposable; the original receipt still owns its payload.
    try { await files.remove({ path: stagingPath, sizeBytes: size, sha256: digest }); }
    catch { /* Cleanup failure must not invalidate the already accepted import. */ }
    return previous;
  }
  const inspected = await inspectMedia(files, stagingPath, size);
  const assetId = randomUUID(), blobId = randomUUID();
  const media = objectRecord.parse({ kind: "media", entityId: assetId, blobId,
    path: `media/${encodeId(assetId)}/${encodeId(blobId)}.${inspected.extension}`, sizeBytes: size, sha256: digest });
  const asset = assetRecord.parse({ schemaVersion: 1, projectId, assetId, revision: 1, name: metadata.name,
    kind: inspected.kind, mimeType: inspected.mimeType, sizeBytes: size, sha256: digest, mediaRef: { kind: "media", entityId: assetId, blobId } });
  const receipt = receiptRecord.parse({ schemaVersion: 1, projectId, metadata, importIdempotencyKey: key, taskId: randomUUID(), stepId: randomUUID(),
    attemptId: randomUUID(), resultId: randomUUID(), artifactId: randomUUID(), stagingPath, asset, media });
  await files.writeJson(`${directory}/received.json`, receipt);
  return receipt;
}

export async function* receivedAssets(files: ProjectFiles, projectId: string, requests: Save[]) {
  let directories: string[];
  try { directories = await files.list("staging/imports"); }
  catch (error) { if (error instanceof StorageIOError && error.errno === 2) return; throw error; }
  for (const directory of directories) {
    const prefix = `staging/imports/${directory}`;
    let bytes: Buffer;
    try { bytes = await files.read(`${prefix}/received.json`); }
    catch (error) { if (error instanceof StorageIOError && error.errno === 2) continue; throw error; }
    let receipt: z.infer<typeof receiptRecord>;
    try { receipt = receiptRecord.parse(JSON.parse(bytes.toString("utf8"))); }
    catch { throw new HostError("PROJECT_INVALID", 409, "A received media record is damaged."); }
    // Older accepted receipts can recover their key from the durable request.
    const key = receipt.importIdempotencyKey ?? requests.find(save => save.route === "asset-imports" &&
      receiptRecord.parse(save.request).resultId === receipt.resultId)?.idempotencyKey;
    const mediaPrefix = `media/${encodeId(receipt.asset.assetId)}/${encodeId(receipt.asset.mediaRef.blobId)}.`;
    if (!key || encodeId(key) !== directory || receipt.projectId !== projectId || receipt.asset.projectId !== projectId ||
        receipt.registrationSourceSaveId || !receipt.stagingPath.startsWith(`${prefix}/`) ||
        receipt.stagingPath.slice(prefix.length + 1).includes("/") || !receipt.stagingPath.endsWith(".part") ||
        receipt.media.kind !== "media" || receipt.media.entityId !== receipt.asset.assetId ||
        receipt.asset.mediaRef.entityId !== receipt.asset.assetId || receipt.media.blobId !== receipt.asset.mediaRef.blobId ||
        receipt.media.sha256 !== receipt.asset.sha256 || receipt.media.sizeBytes !== receipt.asset.sizeBytes ||
        receipt.media.sizeBytes !== receipt.metadata.sizeBytes || !receipt.media.path.startsWith(mediaPrefix) ||
        receipt.media.path.slice(mediaPrefix.length).includes("/")) {
      throw new HostError("PROJECT_INVALID", 409, "A received media record has inconsistent identity or paths.");
    }
    yield { key, receipt };
  }
}

export function prepareAsset(files: ProjectFiles, projectId: string) {
  return async (current: Manifest | null, save: Save) => {
    const receipt = receiptRecord.parse(save.request);
    if (receipt.projectId !== projectId || receipt.asset.projectId !== projectId) throw new HostError("REFERENCE_INVALID", 409, "Import belongs to another project.");
    await files.mkdir(receipt.media.path.slice(0, receipt.media.path.lastIndexOf("/")));
    try { await files.publish(receipt.stagingPath, receipt.media.path); }
    catch (error) { if (!(error instanceof StorageIOError) || ![2, 17].includes(error.errno ?? -1)) throw error; }
    await verifyObject(files, receipt.media);
    const assetRef = { kind: "asset" as const, entityId: receipt.asset.assetId, revision: 1 };
    const resultRef = { kind: "result" as const, entityId: receipt.resultId, revision: 1 };
    const taskRef = { kind: "task" as const, entityId: receipt.taskId, revision: 1 };
    const asset = await writeObject(files, assetRef, `data/assets/${encodeId(receipt.asset.assetId)}/1.json`, receipt.asset);
    const result = await writeObject(files, resultRef, `data/results/${encodeId(receipt.resultId)}/1.json`, {
      schemaVersion: 1, projectId, resultId: receipt.resultId, revision: 1, taskId: receipt.taskId, attemptId: receipt.attemptId,
      registration: "registered", artifacts: [{ artifactId: receipt.artifactId, mediaRef: receipt.asset.mediaRef }],
    });
    const task = await writeObject(files, taskRef, `data/tasks/${encodeId(receipt.taskId)}/1.json`, {
      schemaVersion: 1, projectId, taskId: receipt.taskId, revision: 1, status: "succeeded",
      steps: [{ stepId: receipt.stepId, attemptId: receipt.attemptId, status: "succeeded", resultId: receipt.resultId }],
    });
    const roots = structuredClone(current?.roots ?? emptyRoots());
    for (const [kind, ref] of [["assets", assetRef], ["results", resultRef], ["tasks", taskRef]] as const) {
      if (!roots[kind].some(existing => referenceKey(existing) === referenceKey(ref))) roots[kind].push(ref);
    }
    const objects = new Map((current?.objects ?? []).map(object => [referenceKey(object), object]));
    for (const object of [receipt.media, asset, result, task]) {
      const old = objects.get(referenceKey(object));
      if (old && (old.sha256 !== object.sha256 || old.path !== object.path || old.sizeBytes !== object.sizeBytes)) throw new HostError("OBJECT_ID_CONFLICT", 409, "Import identity differs from an existing object.");
      objects.set(referenceKey(object), object);
    }
    return { roots, objects: [...objects.values()], editorSnapshotId: current?.editorSnapshotId ?? null, editorSequence: current?.editorSequence ?? null };
  };
}

export async function readAsset(files: ProjectFiles, current: Manifest | null, assetId: string, includeHidden = false) {
  const ref = current?.roots.assets.find(item => item.entityId === assetId) ?? (includeHidden ? current?.objects
    .filter(item => item.kind === "asset" && item.entityId === assetId).sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0] : undefined);
  const object = ref && current?.objects.find(item => referenceKey(item) === referenceKey(ref));
  if (!object) throw new HostError("ASSET_NOT_FOUND", 404, "Asset not found.");
  const bytes = await files.read(object.path);
  if (sha256(bytes) !== object.sha256 || bytes.length !== object.sizeBytes) throw new HostError("PROJECT_INVALID", 409, "Asset metadata is damaged.");
  const asset = assetRecord.parse(JSON.parse(bytes.toString("utf8")));
  if (asset.projectId !== current?.projectId || asset.assetId !== assetId || asset.revision !== ref?.revision || asset.mediaRef.entityId !== assetId) {
    throw new HostError("PROJECT_INVALID", 409, "Asset metadata identity differs from its saved reference.");
  }
  return asset;
}
