import { HostError } from "../sessions.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type ProjectFiles, StorageIOError } from "./files.ts";
import { commitRecord, encodeId, entryRecord, manifestRecord, normalizedBytes, objectRecord, sha256, type Entry, type Manifest, type Save } from "./records.ts";
import { receivedAssets, receiptRecord } from "./assets.ts";
import { readTrash } from "./trash.ts";
import { verifyObject } from "./objects.ts";
import { migrationProtection } from "./migration-pins.ts";

const collectionRecord = z.strictObject({ schemaVersion: z.literal(1), projectId: z.string(), gcId: z.string(), savePointId: z.string(),
  commitSequence: z.number().int().positive().safe(), createdAt: z.iso.datetime(), requestKey: z.string().min(1).max(128).optional(),
  completed: z.boolean().default(false), targets: z.array(z.strictObject({ tombstoneId: z.string(), revision: z.number().int().positive().safe(),
    object: objectRecord, status: z.enum(["pending", "removed", "absent", "protected"]), error: z.string().nullable() })) });

async function collectionFailures(files: ProjectFiles, projectId: string) {
  let names: string[];
  try { names = await files.list("staging/gc"); }
  catch (error) { if (error instanceof StorageIOError && error.errno === 2) return new Set<string>(); throw error; }
  const failed = new Set<string>();
  for (const name of names.filter(value => value.endsWith(".json"))) {
    const plan = collectionRecord.parse(JSON.parse((await files.read(`staging/gc/${name}`)).toString("utf8")));
    if (plan.projectId !== projectId || name !== `${plan.gcId}.json`) throw new HostError("PROJECT_INVALID", 409, "Collection record identity changed.");
    for (const target of plan.targets) if (target.status === "pending" && target.error) failed.add(`${target.tombstoneId}:${target.revision}`);
  }
  return failed;
}

async function directoryHasEntries(files: ProjectFiles, path: string) {
  try { return (await files.list(path)).length > 0; }
  catch (error) { if (error instanceof StorageIOError && error.errno === 2) return false; throw error; }
}

async function previousPoint(files: ProjectFiles, entry: Entry) {
  if (!entry.previous) return null;
  const bytes = await files.read(entry.previous.commitPath);
  if (sha256(bytes) !== entry.previous.commitSha256) throw new HostError("PROJECT_INVALID", 409, "The retained commit is damaged.");
  const commit = commitRecord.parse(JSON.parse(bytes.toString("utf8")));
  if (commit.projectId !== entry.projectId || commit.savePointId !== entry.previous.savePointId || commit.commitSequence !== entry.previous.commitSequence) {
    throw new HostError("PROJECT_INVALID", 409, "The retained commit identity changed.");
  }
  const content = await files.read(commit.manifest.path);
  if (content.length !== commit.manifest.sizeBytes || sha256(content) !== commit.manifest.sha256) {
    throw new HostError("PROJECT_INVALID", 409, "The retained save point is damaged.");
  }
  const manifest = manifestRecord.parse(JSON.parse(content.toString("utf8")));
  if (manifest.projectId !== entry.projectId || manifest.savePointId !== commit.savePointId || manifest.saveId !== commit.saveId) {
    throw new HostError("PROJECT_INVALID", 409, "The retained save point identity changed.");
  }
  return manifest;
}

// Called inside the project's commit queue so the current and previous roots agree.
export async function inspectRetention(files: ProjectFiles, current: Manifest, entry: Entry, requests: Save[]) {
  const previous = await previousPoint(files, entry);
  const failures = await collectionFailures(files, current.projectId);
  const migrations = await migrationProtection(files, current.projectId);
  const globalReasons: string[] = [];
  if (migrations.unresolved) globalReasons.push("migration-pin");
  for (const [directory, reason] of [["refs/tasks", "task-pin"], ["quarantine", "quarantine"]]) {
    if (await directoryHasEntries(files, directory)) globalReasons.push(reason);
  }
  if (requests.some(save => ["queued", "writing"].includes(save.status))) globalReasons.push("pending-save");
  const pendingMedia = new Set<string>();
  for (const save of requests) {
    if (["asset-imports", "result-registrations"].includes(save.route) && save.status !== "succeeded") {
      pendingMedia.add(receiptRecord.parse(save.request).media.path);
    }
  }
  for await (const { key, receipt } of receivedAssets(files, current.projectId, requests)) {
    if (!requests.some(save => save.route === "asset-imports" && save.idempotencyKey === key)) pendingMedia.add(receipt.media.path);
  }
  const items = [];
  for (const item of await readTrash(files, current)) {
    if (item.restoredAt) continue;
    const reasons = new Set(globalReasons);
    if (!item.purgeRequestedAt) reasons.add("trash");
    if (!item.media || !item.assetObject) reasons.add("metadata-unavailable");
    if (item.media) {
      if (migrations.paths.has(item.media.path)) reasons.add("migration-pin");
      if (current.objects.some(object => object.path === item.media!.path)) reasons.add("current-save-point");
      if (previous?.objects.some(object => object.path === item.media!.path)) reasons.add("previous-save-point");
      if (pendingMedia.has(item.media.path)) reasons.add("pending-registration");
    }
    let recoverable = false, mediaState: "present" | "absent" | "unverified" = "unverified";
    if (item.media && item.assetObject) {
      try { await verifyObject(files, item.media); mediaState = "present"; }
      catch (error) {
        if (error instanceof StorageIOError && error.errno === 2) mediaState = "absent";
        else reasons.add("media-unverified");
      }
      if (mediaState === "present") {
        try { await verifyObject(files, item.assetObject); recoverable = true; }
        catch { reasons.add("metadata-unverified"); }
      }
    }
    const eligible = mediaState === "present" && reasons.size === 0;
    items.push({ ...item, recoverable, protectedReasons: [...reasons], mediaState, eligible,
      collectionFailed: mediaState !== "absent" && failures.has(`${item.tombstoneId}:${item.revision}`),
      reclaimableBytes: mediaState === "unverified" ? null : eligible ? item.media!.sizeBytes : 0 });
  }
  return { savePointId: current.savePointId, commitSequence: entry.current.commitSequence, items };
}

export async function collectProjectGarbage(files: ProjectFiles, current: Manifest, entry: Entry, requests: Save[], key?: string) {
  if (!current.roots.trash.length && !key) return;
  const gcId = key ? encodeId(`collection-retry:${current.projectId}:${key}`) : randomUUID(), path = `staging/gc/${gcId}.json`;
  let plan: z.infer<typeof collectionRecord> | undefined;
  if (key) {
    try { plan = collectionRecord.parse(JSON.parse((await files.read(path)).toString("utf8"))); }
    catch (error) { if (!(error instanceof StorageIOError) || error.errno !== 2) throw error; }
    if (plan && (plan.projectId !== current.projectId || plan.gcId !== gcId || plan.requestKey !== key)) throw new HostError("IDEMPOTENCY_KEY_REUSED", 409, "Collection request identity differs.");
    if (plan?.completed) return { plan, replayed: true };
  }
  const inventory = await inspectRetention(files, current, entry, requests);
  const replayed = Boolean(plan);
  if (!plan) {
    const targets = inventory.items.filter(item => item.eligible).map(item => ({ tombstoneId: item.tombstoneId,
      revision: item.revision, object: item.media!, status: "pending", error: null }));
    if (!targets.length && !key) return;
    plan = collectionRecord.parse({ schemaVersion: 1, projectId: current.projectId, gcId, savePointId: current.savePointId,
      commitSequence: entry.current.commitSequence, createdAt: new Date().toISOString(), ...(key ? { requestKey: key } : {}), targets });
    await files.mkdir("staging/gc");
    await files.writeJson(path, plan);
  }
  for (const target of plan.targets) {
    if (["removed", "absent"].includes(target.status)) continue;
    const item = inventory.items.find(value => value.tombstoneId === target.tombstoneId && value.revision === target.revision);
    if (!item || !item.media || !normalizedBytes(item.media).equals(normalizedBytes(target.object)) || (!item.eligible && item.mediaState !== "absent")) {
      target.status = "protected"; target.error = null;
      await files.writeJson(path, plan, true); continue;
    }
    if (item.mediaState === "absent") {
      target.status = "absent"; target.error = null;
      await files.writeJson(path, plan, true); continue;
    }
    const locator = entryRecord.parse(JSON.parse((await files.read("project.json")).toString("utf8")));
    if (!normalizedBytes(locator).equals(normalizedBytes(entry))) throw new HostError("REFERENCE_STALE", 409, "Project roots changed before collection.");
    try {
      await files.remove(target.object);
      target.status = "removed"; target.error = null;
    } catch (error) {
      if (error instanceof StorageIOError && error.errno === 2) target.status = "absent";
      else {
        target.status = "pending";
        target.error = error instanceof HostError ? error.code : "STORAGE_IO_FAILED";
      }
    }
    await files.writeJson(path, plan, true);
  }
  plan.completed = true;
  await files.writeJson(path, plan, true);
  return { plan, replayed };
}
