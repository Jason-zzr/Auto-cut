import { z } from "zod";
import { HostError } from "../sessions.ts";
import type { ProjectFiles } from "./files.ts";
import { assetRecord, readAsset } from "./assets.ts";
import { encodeId, normalizedBytes, objectRecord, objectReference, referenceKey, sha256, type Manifest, type Save } from "./records.ts";
import { verifyObject, writeObject } from "./objects.ts";

const revision = z.number().int().positive().safe();
export const tombstoneRecord = z.strictObject({ schemaVersion: z.literal(1), projectId: z.string().min(1),
  tombstoneId: z.string().min(1), revision, assetId: z.string().min(1),
  assetRef: objectReference.extend({ kind: z.literal("asset"), revision }),
  assetObject: objectRecord.optional(), media: objectRecord.optional(),
  name: z.string(), deletedAt: z.iso.datetime(), restoredAt: z.iso.datetime().optional(), purgeRequestedAt: z.iso.datetime().optional() });
export const emptyTrashSelection = z.strictObject({ items: z.array(z.strictObject({ tombstoneId: z.string().min(1).max(256), revision })).min(1).max(1000),
  digest: z.string().length(64) });
export type EmptyTrashSelection = z.infer<typeof emptyTrashSelection>;
export function emptyTrashDigest(projectId: string, items: EmptyTrashSelection["items"]) {
  return sha256(normalizedBytes({ projectId, items: [...items].sort((a, b) => a.tombstoneId < b.tombstoneId ? -1 : a.tombstoneId > b.tombstoneId ? 1 : 0) }));
}
export async function validateEmptyTrash(files: ProjectFiles, current: Manifest | null, value: EmptyTrashSelection) {
  const input = emptyTrashSelection.parse(value);
  if (!current || new Set(input.items.map(item => item.tombstoneId)).size !== input.items.length ||
      emptyTrashDigest(current.projectId, input.items) !== input.digest) throw new HostError("REFERENCE_STALE", 409, "Review the exact trash selection again.");
  const entries = await readTrash(files, current);
  for (const selected of input.items) {
    const entry = entries.find(item => item.tombstoneId === selected.tombstoneId);
    if (!entry || entry.restoredAt || entry.purgeRequestedAt || entry.revision !== selected.revision) {
      throw new HostError("REFERENCE_STALE", 409, "A selected trash entry changed.");
    }
  }
  return input;
}
export const trashRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("delete"), assetId: z.string().min(1).max(256), revision }),
  z.strictObject({ action: z.literal("restore"), tombstoneId: z.string().min(1).max(256), revision }),
]);
export type TrashRequest = z.infer<typeof trashRequest>;

export async function readTrash(files: ProjectFiles, current: Manifest | null) {
  const items = [];
  for (const ref of current?.roots.trash ?? []) {
    const object = current!.objects.find(item => referenceKey(item) === referenceKey(ref));
    if (!object) throw new HostError("PROJECT_INVALID", 409, "Trash metadata is missing.");
    const bytes = await files.read(object.path);
    if (bytes.length !== object.sizeBytes || sha256(bytes) !== object.sha256) throw new HostError("PROJECT_INVALID", 409, "Trash metadata is damaged.");
    const item = tombstoneRecord.parse(JSON.parse(bytes.toString("utf8")));
    if (item.projectId !== current!.projectId || item.tombstoneId !== ref.entityId || item.revision !== ref.revision) {
      throw new HostError("PROJECT_INVALID", 409, "Trash identity differs from its saved reference.");
    }
    items.push(item);
  }
  return items;
}

export function prepareTrash(files: ProjectFiles, projectId: string) {
  return async (current: Manifest | null, save: Save) => {
    if (!current) throw new HostError("PROJECT_NOT_FOUND", 404, "A complete project is required.");
    const request = trashRequest.parse(save.request), roots = structuredClone(current.roots);
    const objects = new Map(current.objects.map(item => [referenceKey(item), item]));
    let tombstone: z.infer<typeof tombstoneRecord>;
    if (request.action === "delete") {
      const asset = await readAsset(files, current, request.assetId);
      if (asset.revision !== request.revision) throw new HostError("REVISION_CONFLICT", 409, "The asset revision changed.");
      tombstone = { schemaVersion: 1, projectId, tombstoneId: save.saveId, revision: 1, assetId: asset.assetId,
        assetRef: { kind: "asset", entityId: asset.assetId, revision: asset.revision },
        assetObject: objects.get(referenceKey({ kind: "asset", entityId: asset.assetId, revision: asset.revision })),
        media: objects.get(referenceKey(asset.mediaRef)), name: asset.name, deletedAt: save.createdAt };
      roots.assets = roots.assets.filter(ref => ref.entityId !== asset.assetId);
    } else {
      const previous = (await readTrash(files, current)).find(item => item.tombstoneId === request.tombstoneId);
      if (!previous || previous.restoredAt || previous.revision !== request.revision || roots.assets.some(ref => ref.entityId === previous.assetId)) {
        throw new HostError("REVISION_CONFLICT", 409, "This trash entry is no longer available for restoration.");
      }
      const source = objects.get(referenceKey(previous.assetRef)) ?? previous.assetObject;
      if (!source) throw new HostError("REFERENCE_INVALID", 409, "The original asset is no longer available.");
      await verifyObject(files, source);
      const asset = assetRecord.parse(JSON.parse((await files.read(source.path)).toString("utf8")));
      if (asset.projectId !== projectId || asset.assetId !== previous.assetId || asset.revision !== previous.assetRef.revision) {
        throw new HostError("REFERENCE_INVALID", 409, "The original asset identity changed.");
      }
      const media = objects.get(referenceKey(asset.mediaRef)) ?? previous.media;
      if (!media || referenceKey(media) !== referenceKey(asset.mediaRef) || media.sha256 !== asset.sha256 || media.sizeBytes !== asset.sizeBytes) {
        throw new HostError("REFERENCE_INVALID", 409, "The original media identity is unavailable.");
      }
      await verifyObject(files, media);
      objects.set(referenceKey(media), media);
      const restored = { ...asset, revision: Math.max(asset.revision, ...current.objects.filter(item => item.kind === "asset" && item.entityId === asset.assetId).map(item => item.revision ?? 0)) + 1 };
      const ref = { kind: "asset" as const, entityId: asset.assetId, revision: restored.revision };
      const object = await writeObject(files, ref, `data/assets/${encodeId(asset.assetId)}/${restored.revision}.json`, restored);
      objects.set(referenceKey(object), object); roots.assets.push(ref);
      tombstone = { ...previous, revision: previous.revision + 1, restoredAt: save.createdAt };
    }
    const ref = { kind: "trash" as const, entityId: tombstone.tombstoneId, revision: tombstone.revision };
    const object = await writeObject(files, ref, `data/trash/${encodeId(tombstone.tombstoneId)}/${tombstone.revision}.json`, tombstone);
    roots.trash = [...roots.trash.filter(item => item.entityId !== tombstone.tombstoneId), ref];
    for (const [key, item] of objects) if (item.kind === "trash" && item.entityId === tombstone.tombstoneId) objects.delete(key);
    objects.set(referenceKey(object), object);
    return { roots, objects: [...objects.values()], editorSnapshotId: current.editorSnapshotId, editorSequence: current.editorSequence };
  };
}

export function prepareEmptyTrash(files: ProjectFiles) {
  return async (current: Manifest | null, save: Save) => {
    const input = await validateEmptyTrash(files, current, emptyTrashSelection.parse(save.request));
    const roots = structuredClone(current!.roots), objects = new Map(current!.objects.map(item => [referenceKey(item), item]));
    const entries = await readTrash(files, current);
    for (const selected of input.items) {
      const previous = entries.find(item => item.tombstoneId === selected.tombstoneId)!;
      const item = { ...previous, revision: previous.revision + 1, purgeRequestedAt: save.createdAt };
      const ref = { kind: "trash" as const, entityId: item.tombstoneId, revision: item.revision };
      const object = await writeObject(files, ref, `data/trash/${encodeId(item.tombstoneId)}/${item.revision}.json`, item);
      roots.trash = [...roots.trash.filter(value => value.entityId !== item.tombstoneId), ref];
      for (const [key, value] of objects) if (value.kind === "trash" && value.entityId === item.tombstoneId) objects.delete(key);
      objects.set(referenceKey(object), object);
    }
    return { roots, objects: [...objects.values()], editorSnapshotId: current!.editorSnapshotId, editorSequence: current!.editorSequence };
  };
}
