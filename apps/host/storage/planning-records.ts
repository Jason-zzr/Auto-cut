import { z } from "zod";
import { scriptContent, scriptDraft, scriptRef } from "./script-records.ts";
import { planningProviderConfig } from "../planning-provider.ts";
const id = z.string().min(1).max(256);
export const planningTaskRecord = z.strictObject({ schemaVersion: z.literal(1), format: z.literal("script-planning-task"),
  projectId: id, taskId: id, revision: z.number().int().positive().safe(), attemptId: id,
  previousRef: z.strictObject({ kind: z.literal("task"), entityId: id, revision: z.number().int().positive().safe() }).nullable(),
  status: z.enum(["prepared", "dispatched", "remote_unknown", "output_ready", "registered", "failed"]),
  provider: planningProviderConfig, requestDigest: z.string().length(64), inputDigest: z.string().length(64), inputText: z.string().max(2_000_000),
  groups: z.array(z.strictObject({ inputText: z.string().max(2_000_000), digest: z.string().length(64),
    output: scriptContent.nullable(), remoteId: z.string().max(512).nullable() })).max(1000),
  activeGroup: z.number().int().nonnegative().nullable(),
  basis: scriptDraft, output: scriptDraft.nullable(), remoteId: z.string().max(512).nullable(), scriptRef: scriptRef.nullable(),
  error: z.string().max(1024), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type PlanningTask = z.infer<typeof planningTaskRecord>;
