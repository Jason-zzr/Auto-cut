import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mapTimeline, transitionCatalog } from "../../apps/host/jianying-draft/timeline-mapper.ts";
import { serializeDraft, writeDraft, draftSettings } from "../../apps/host/jianying-draft/draft-writer.ts";
import { jianyingDraftRoot, validateDraftName } from "../../apps/host/jianying-draft/jianying-paths.ts";
import { builtInStickerMedia } from "../../apps/host/jianying-draft/jianying-export-service.ts";

const directory = fileURLToPath(new URL(".", import.meta.url));
const fixture = JSON.parse(await readFile(process.argv[2] || join(directory, "fixtures/sample-snapshot.json"), "utf8"));
const resolveMedia = ref => ref ? fixture.media[ref.entityId] : undefined;
const resolveSticker = stickerId => stickerId === "trend-flame" ? fixture.media.sticker : undefined;

function canonical(draft) {
  // IDs are random, but every link is still compared through a consistent canonical identity.
  const ids = new Map();
  const materialIds = new Set(Object.values(draft.materials).flat().map(material => material.id));
  draft.tracks.forEach((track, index) => {
    ids.set(track.id, `track:${index}`);
    track.segments.forEach((segment, i) => {
      const prefix = `track:${index}:segment:${i}`;
      ids.set(segment.id, prefix);
      assert(materialIds.has(segment.material_id), "Missing primary material");
      ids.set(segment.material_id, `${prefix}:material`);
      segment.extra_material_refs.forEach((ref, j) => {
        assert(materialIds.has(ref), "Dangling extra_material_refs");
        ids.set(ref, `${prefix}:extra:${j}`);
      });
    });
  });
  const visit = value => {
    if (typeof value === "string") return ids.get(value) || value;
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, key === "content" && typeof item === "string" ? visit(JSON.parse(item)) : visit(item)]));
  };
  const normalized = visit({ canvas_config: draft.canvas_config, duration: draft.duration, fps: draft.fps, materials: draft.materials, tracks: draft.tracks });
  for (const values of Object.values(normalized.materials)) values.sort((a, b) => a.id.localeCompare(b.id));
  return normalized;
}

for (const transition of Object.keys(transitionCatalog)) {
  const sample = structuredClone(fixture);
  sample.payload.visualSegments[0].transition.id = transition;
  const model = mapTimeline(sample.payload, resolveMedia, resolveSticker);
  const reference = spawnSync(process.env.PYTHON || "python3", [join(directory, "generate-reference.py")], {
    input: JSON.stringify(sample), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (reference.status !== 0) throw new Error(`Python oracle failed: ${reference.stderr}`);
  try { assert.deepStrictEqual(canonical(serializeDraft(model)), canonical(JSON.parse(reference.stdout))); }
  catch (error) { throw new Error(`Golden ${transition}: ${error.message.slice(0, 12000)}`, { cause: error }); }
  assert(model.report.mapped.some(item => item.segmentId === "s1" && item.feature === "sticker"));
  assert(model.report.skipped.some(item => item.segmentId === "mark1" && item.feature === "marker"));
}
const model = mapTimeline(fixture.payload, resolveMedia, resolveSticker);
const builtInStickers = await builtInStickerMedia(fileURLToPath(new URL("../../dist", import.meta.url)), fixture.payload);
assert.equal(builtInStickers.get("trend-flame")?.mimeType, "image/png");
assert((builtInStickers.get("trend-flame")?.width ?? 0) > 0 && (builtInStickers.get("trend-flame")?.height ?? 0) > 0);
const sticker = model.tracks.find(track => track.name === "sticker-0")?.segments[0];
assert(sticker);
assert.deepStrictEqual(sticker.clip, { alpha: 0.8, flip: { horizontal: false, vertical: false }, rotation: 15,
  scale: { x: 0.264, y: 0.264 }, transform: { x: 0.64, y: 0.6 } });
const missing = mapTimeline(fixture.payload, () => undefined, resolveSticker);
assert(missing.report.skipped.some(item => item.segmentId === "v1" && item.feature === "media"));
const unsupported = structuredClone(fixture.payload);
unsupported.visualSegments[0].speedCurve = { enabled: true };
unsupported.visualSegments[1].keyframes = [{ time: 0, scale: 2 }];
const degraded = mapTimeline(unsupported, resolveMedia, resolveSticker);
assert(degraded.report.skipped.some(item => item.segmentId === "v1" && item.feature === "timing"));
assert(degraded.report.skipped.some(item => item.segmentId === "v2" && item.feature === "keyframes"));
assert.throws(() => validateDraftName("../escape"));
await assert.rejects(jianyingDraftRoot(undefined, "win32"), { code: "COMPONENT_NOT_READY" });
const root = await mkdtemp(join(tmpdir(), "autocut-jianying-golden-"));
await assert.rejects(jianyingDraftRoot(undefined, "darwin", root), { code: "JIANYING_DRAFT_ROOT_NOT_FOUND" });
assert.equal(await jianyingDraftRoot(root), await realpath(root));
const output = await writeDraft(root, "中文 golden draft", model);
assert.deepStrictEqual((await readdir(output.draftPath)).sort(), ["draft_info.json", "draft_meta_info.json", "draft_settings", "key_value.json"].sort());
assert.equal(await readFile(join(output.draftPath, "draft_settings"), "utf8"), draftSettings);
assert.equal(draftSettings, await readFile(new URL("../../apps/host/jianying-draft/assets/draft_settings_template", import.meta.url), "utf8"));
const info = JSON.parse(await readFile(join(output.draftPath, "draft_info.json"), "utf8"));
const meta = JSON.parse(await readFile(join(output.draftPath, "draft_meta_info.json"), "utf8"));
assert.equal(meta.draft_id, info.id);
assert.equal(meta.tm_duration, info.duration);
assert.equal(meta.draft_fold_path, output.draftPath);
await assert.rejects(writeDraft(root, "中文 golden draft", model), { code: "TARGET_NOT_EMPTY" });
console.log(`PASS: eight transition and sticker-image-layer field comparisons, real dist sticker PNG resolution, skip reports, platform/root errors and non-overwriting four-file output.\nSynthetic artifacts retained: ${root}\nNot verified: actual project-media probing, authenticated host route, or opening in Jianying.`);
