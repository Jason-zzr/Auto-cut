import { z } from "zod";
import { normalizedBytes, sha256 } from "./records.ts";

const id = z.string().min(1).max(256);
const revision = z.number().int().positive().safe();
const seconds = z.number().finite().nonnegative();
const digest = z.string().length(64).refine(value => [...value].every(char => "0123456789abcdef".includes(char)));
export const analysisRef = z.strictObject({ kind: z.literal("analysis"), entityId: id, revision });
export const analysisTaskRef = z.strictObject({ kind: z.literal("task"), entityId: id, revision });
export const sourceRange = z.strictObject({ sourceStartSeconds: seconds, sourceEndSeconds: seconds })
  .refine(value => value.sourceEndSeconds >= value.sourceStartSeconds, "Source range is reversed.");
export const analysisBasis = z.strictObject({
  assetRef: z.strictObject({ kind: z.literal("asset"), entityId: id, revision }),
  mediaRef: z.strictObject({ kind: z.literal("media"), entityId: id, blobId: id }),
  contentSha256: digest, range: sourceRange,
  capability: z.enum(["speech", "visual", "detection", "description"]),
  model: z.strictObject({ id, revision: id.nullable(), precision: id, runtime: id }),
  settings: z.strictObject({ language: z.string().max(64), sampleIntervalSeconds: seconds.positive(),
    speechSegmentation: z.strictObject({ modelSha256: digest, threshold: z.number().min(0).max(1),
      negativeThreshold: z.number().min(0).max(1), minimumSilenceSeconds: seconds, paddingSeconds: seconds }).optional() }),
});
export const analysisWord = z.strictObject({ text: z.string().max(16384), sourceStartSeconds: seconds, sourceEndSeconds: seconds });
const detection = z.strictObject({ label: z.string().max(256), score: z.number().min(0).max(1),
  box: z.strictObject({ xmin: seconds, ymin: seconds, xmax: seconds, ymax: seconds }) });
export const analysisOutput = z.strictObject({ text: z.string().max(2_000_000), language: z.string().max(64),
  words: z.array(analysisWord).max(100_000),
  samples: z.array(z.strictObject({ sourceTimeSeconds: seconds, sceneScore: seconds.nullable(), motionScore: seconds.nullable(),
    qualityScore: seconds.nullable(), detections: z.array(detection).max(1000), description: z.string().max(16384),
    sources: z.array(id).max(16) })).max(100_000),
  coverage: z.array(sourceRange).max(100_000), complete: z.boolean(), missingCapabilities: z.array(id).max(16),
});
export const analysisCorrection = z.strictObject({ text: z.string().max(2_000_000),
  intervals: z.array(z.strictObject({ range: sourceRange, text: z.string().max(16384),
    labels: z.array(z.string().min(1).max(256)).max(100), visualNotes: z.string().max(16384) })).max(100_000) });
export const rawAnalysisRecord = z.strictObject({ schemaVersion: z.literal(1), format: z.literal("material-analysis"),
  projectId: id, analysisId: id, revision: z.literal(1), taskId: id, attemptId: id, resultId: id,
  basis: analysisBasis, basisDigest: digest, output: analysisOutput, createdAt: z.iso.datetime() });
export const correctedAnalysisRecord = z.strictObject({ schemaVersion: z.literal(1), format: z.literal("material-analysis-correction"),
  projectId: id, analysisId: id, revision, rawRef: analysisRef, previousRef: analysisRef,
  correction: analysisCorrection, createdAt: z.iso.datetime() });
export const analysisRecord = z.discriminatedUnion("format", [rawAnalysisRecord, correctedAnalysisRecord]);
export const analysisStep = z.strictObject({ stepId: id, basis: analysisBasis,
  attemptId: id, status: z.enum(["queued", "running", "cancel_requested", "cancelled", "failed", "interrupted", "succeeded"]),
  checkpoints: z.array(z.strictObject({ range: sourceRange, output: analysisOutput })).max(100_000),
  resultId: id.nullable(), analysisRef: analysisRef.nullable(),
  error: z.strictObject({ code: id, message: z.string().max(1024) }).nullable() });
export const analysisTaskRecord = z.strictObject({ schemaVersion: z.literal(1), format: z.literal("material-analysis-task"),
  projectId: id, taskId: id, revision, previousRef: analysisTaskRef.nullable(),
  steps: z.array(analysisStep).min(1).max(1000), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export const analysisResultRecord = z.strictObject({ schemaVersion: z.literal(1), format: z.literal("material-analysis-result"),
  projectId: id, resultId: id, revision: z.literal(1), taskId: id, attemptId: id,
  registration: z.literal("registered"), analysisRef, taskRef: analysisTaskRef });
export type AnalysisBasis = z.infer<typeof analysisBasis>;
export type AnalysisOutput = z.infer<typeof analysisOutput>;
export type AnalysisTask = z.infer<typeof analysisTaskRecord>;
export function analysisBasisDigest(basis: AnalysisBasis) { return sha256(normalizedBytes(basis)); }

export function validAnalysisOutput(basis: AnalysisBasis, output: AnalysisOutput) {
  const { sourceStartSeconds: start, sourceEndSeconds: end } = basis.range;
  const inside = (range: z.infer<typeof sourceRange>) => range.sourceStartSeconds >= start &&
    range.sourceEndSeconds <= end && range.sourceEndSeconds >= range.sourceStartSeconds;
  if (!output.words.every(inside) || !output.coverage.every(inside) ||
      !output.samples.every(sample => sample.sourceTimeSeconds >= start && sample.sourceTimeSeconds <= end)) return false;
  const coverage = [...output.coverage].sort((a, b) => a.sourceStartSeconds - b.sourceStartSeconds);
  let covered = start;
  for (const range of coverage) {
    if (range.sourceStartSeconds > covered) break;
    covered = Math.max(covered, range.sourceEndSeconds);
  }
  return !output.complete || (coverage.length > 0 && covered >= end && output.missingCapabilities.length === 0);
}
