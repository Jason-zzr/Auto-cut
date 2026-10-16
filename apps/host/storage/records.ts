import { z } from "zod";
import { createHash } from "node:crypto";

const id = z.string().min(1).max(256);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().length(64).refine(value => [...value].every(char => "0123456789abcdef".includes(char)));
const path = z.string().min(1).max(4096).refine(value => !value.includes("\\") && !value.includes("\0") &&
  value.split("/").every(part => part.length > 0 && part !== "." && part !== ".."));
const timestamp = z.iso.datetime();
export const objectReference = z.strictObject({
  kind: z.enum(["asset", "media", "editor-snapshot", "analysis", "script", "plan", "task", "result", "trash", "resource"]),
  entityId: id, revision: integer.optional(), blobId: id.optional(),
});
export const objectRecord = objectReference.extend({ path, sizeBytes: integer, sha256: digest });
export const exportPublicationRecord = z.strictObject({ parent: z.string().min(1), temporary: path, name: path,
  sizeBytes: integer.positive(), sha256: digest });
export type ExportPublication = z.infer<typeof exportPublicationRecord>;
const roots = z.record(z.enum(["assets", "analyses", "scripts", "plans", "tasks", "results", "editorSnapshots", "trash", "resources"]), z.array(objectReference));
export const manifestRecord = z.strictObject({
  schemaVersion: z.literal(1), projectId: id, savePointId: id, saveId: id, createdAt: timestamp,
  previousSavePointId: id.nullable(), editorSnapshotId: id.nullable(), editorSequence: integer.nullable(),
  roots, objects: z.array(objectRecord),
});
export const commitRecord = z.strictObject({
  schemaVersion: z.literal(1), projectId: id, commitSequence: integer.positive(), previousCommitSequence: integer,
  saveId: id, savePointId: id, manifest: z.strictObject({ path, sizeBytes: integer, sha256: digest }), createdAt: timestamp,
  recoveredFromSavePointId: id.optional(),
});
const point = z.strictObject({ commitSequence: integer.positive(), savePointId: id, commitPath: path, commitSha256: digest });
export const entryRecord = z.strictObject({
  schemaVersion: z.literal(1), projectId: id, entryRevision: integer.positive(), current: point, previous: point.nullable(),
});
export const saveRecord = z.strictObject({
  schemaVersion: z.literal(1), projectId: id, saveId: id, route: id, subject: id,
  idempotencyKey: z.string().min(1).max(128), requestDigest: digest,
  status: z.enum(["queued", "writing", "succeeded", "failed"]),
  savePointId: id, requestSequence: integer.positive(), createdAt: timestamp, editorSnapshotId: id.nullable(), editorSequence: integer.nullable(),
  request: z.json(), error: z.strictObject({ code: id, message: z.string().max(1024) }).optional(),
});

export type ObjectReference = z.infer<typeof objectReference>;
export type ObjectRecord = z.infer<typeof objectRecord>;
export type Manifest = z.infer<typeof manifestRecord>;
export type Commit = z.infer<typeof commitRecord>;
export type Entry = z.infer<typeof entryRecord>;
export type Save = z.infer<typeof saveRecord>;

export function emptyRoots(): Manifest["roots"] {
  return { assets: [], analyses: [], scripts: [], plans: [], tasks: [], results: [], editorSnapshots: [], trash: [], resources: [] };
}

// Fixed-length, case-stable names keep opaque IDs below filesystem component limits.
export function encodeId(value: string) { return sha256(Buffer.from(id.parse(value), "utf8")); }
export function sha256(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
export function jsonBytes(value: unknown) { return Buffer.from(JSON.stringify(value) + "\n", "utf8"); }
export function normalizedBytes(value: unknown): Buffer {
  const order = (input: unknown): unknown => Array.isArray(input) ? input.map(order) :
    input !== null && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, order(item)])) : input;
  return jsonBytes(order(value));
}
export function referenceKey(value: ObjectReference) {
  return JSON.stringify([value.kind, value.entityId, value.revision ?? null, value.blobId ?? null]);
}

export function commitPath(sequence: number, savePointId: string) {
  return `saves/commits/${String(sequence).padStart(16, "0")}-${encodeId(savePointId)}.json`;
}
