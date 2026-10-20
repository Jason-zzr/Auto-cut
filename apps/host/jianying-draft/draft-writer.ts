import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import template from "./assets/draft_info_template.json" with { type: "json" };
import metaTemplate from "./assets/draft_meta_info.json" with { type: "json" };
import keyValue from "./assets/key_value_template.json" with { type: "json" };
import { HostError } from "../sessions.ts";
import { transitionCatalog } from "./timeline-mapper.ts";
import type { DraftClip, DraftModel } from "./draft-types.ts";

type Material = Record<string, unknown>;
const id = () => randomUUID().replaceAll("-", "");
// Embedded for bundled/SEA hosts; the golden harness checks the original asset bytes.
export const draftSettings = "[General]\ndraft_create_time=0\ndraft_last_edit_time=0\nreal_edit_keys=1\nreal_edit_seconds=0\n";

export function serializeDraft(model: DraftModel) {
  const content = structuredClone(template);
  const materials: Record<string, Material[]> = content.materials;
  const tracks: Material[] = [];
  let duration = 0;
  const material = (clip: DraftClip, materialId: string) => {
    if (clip.text !== undefined) {
      materials.texts.push({ id: materialId, content: JSON.stringify({
        styles: [{ fill: { alpha: 1, content: { render_type: "solid", solid: { alpha: 1, color: [1, 1, 1] } } },
          range: [0, [...clip.text].length], size: 8, bold: false, italic: false, underline: false, strokes: [] }], text: clip.text,
      }), typesetting: 0, alignment: 0, letter_spacing: 0, line_spacing: 0.02, line_feed: 1,
      line_max_width: 0.82, force_apply_line_max_width: false, check_flag: 7, type: "text", global_alpha: 1 });
      return;
    }
    const media = clip.media!;
    const mediaDuration = media.kind === "image" ? Math.max(10_800_000_000, clip.source!.start + clip.source!.duration) : Math.round((media.durationSeconds ??
      ((clip.source!.start + clip.source!.duration) / 1_000_000)) * 1_000_000);
    const common = { id: materialId, path: media.path, duration: mediaDuration,
      local_material_id: basename(media.path, extname(media.path)), source_platform: 0 };
    if (media.kind === "audio") {
      materials.audios.push({ ...common, app_id: 0, category_id: "", category_name: "local", check_flag: 3,
        copyright_limit_type: "none", effect_id: "", formula_id: "", music_id: materialId,
        name: clip.name || basename(media.path), type: "extract_music", wave_points: [] });
    } else {
      materials.videos.push({ ...common, audio_fade: null, category_id: "", category_name: "local", check_flag: 63487,
        crop: { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0,
          lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 },
        crop_ratio: "free", crop_scale: 1, height: clip.height, width: clip.width, material_id: materialId,
        material_name: clip.name || basename(media.path), media_path: "", type: media.kind === "image" ? "photo" : "video",
        video_algorithm: { algorithms: [], complement_frame_config: null, deflicker: null, gameplay_configs: [],
          motion_blur_config: null, noise_reduction: null, path: "", quality_enhance: null, time_range: null }, team_id: "" });
    }
  };
  for (const track of [...model.tracks].sort((a, b) => a.renderIndex - b.renderIndex)) {
    const segments = [...track.segments].sort((a, b) => a.target.start - b.target.start).map(clip => {
      const materialId = id(), speedId = id();
      material(clip, materialId);
      materials.speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: clip.speed, type: "speed" });
      const refs = [speedId];
      if (clip.transition) {
        const meta = transitionCatalog[clip.transition.id], transitionId = id();
        materials.transitions.push({ category_id: "", category_name: "", duration: clip.transition.duration,
          effect_id: meta.effectId, id: transitionId, is_overlap: meta.overlap, name: meta.name,
          platform: "all", resource_id: meta.resourceId, type: "transition" });
        refs.push(transitionId);
      }
      duration = Math.max(duration, clip.target.start + clip.target.duration);
      return { enable_adjust: true, enable_color_correct_adjust: false, enable_color_curves: true,
        enable_color_match_adjust: false, enable_color_wheels: true, enable_lut: true, enable_smart_color_adjust: false,
        last_nonzero_volume: 1, reverse: false, track_attribute: 0, track_render_index: 0, visible: true,
        id: id(), material_id: materialId, target_timerange: clip.target, common_keyframes: [], keyframe_refs: [],
        source_timerange: clip.source, speed: clip.speed, volume: clip.volume, extra_material_refs: refs,
        is_tone_modify: false, clip: clip.clip,
        ...(clip.clip ? { uniform_scale: { on: true, value: 1 } } : {}),
        ...(track.type === "video" ? { hdr_settings: { intensity: 1, mode: 1, nits: 1000 } } :
          track.type === "audio" ? { hdr_settings: null } : {}),
        render_index: track.renderIndex };
    });
    tracks.push({ attribute: 0, flag: 0, id: id(), is_default_name: !track.name, name: track.name, segments, type: track.type });
  }
  return { ...content, fps: model.fps, duration, canvas_config: { width: model.width, height: model.height, ratio: "original" }, tracks };
}

export async function writeDraft(root: string, name: string, model: DraftModel) {
  const draftPath = join(root, name), content = serializeDraft(model), draftId = randomUUID().toUpperCase();
  const timestamp = Date.now() * 1000;
  content.id = draftId; content.name = name;
  content.create_time = Math.floor(timestamp / 1000); content.update_time = Math.floor(timestamp / 1000);
  content.platform.os = "mac"; content.last_modified_platform.os = "mac";
  const metadata = { ...structuredClone(metaTemplate), draft_id: draftId, draft_name: name,
    draft_fold_path: draftPath, draft_root_path: root, tm_duration: content.duration,
    tm_draft_create: timestamp, tm_draft_modified: timestamp };
  try { await mkdir(draftPath); }
  catch (error) {
    throw new HostError(error && typeof error === "object" && "code" in error && error.code === "EEXIST" ? "TARGET_NOT_EMPTY" : "STORAGE_IO_FAILED",
      error && typeof error === "object" && "code" in error && error.code === "EEXIST" ? 409 : 503,
      "Could not create a new draft directory. Existing drafts are never overwritten.");
  }
  try {
    // Metadata is written last; interrupted output is retained for diagnosis, never reported as complete.
    for (const [filename, value] of [
      ["draft_info.json", JSON.stringify(content, null, 2)],
      ["draft_settings", draftSettings], ["key_value.json", JSON.stringify(keyValue)],
      ["draft_meta_info.json", JSON.stringify(metadata, null, 2)],
    ]) {
      const file = await open(join(draftPath, filename), "wx", 0o600);
      try { await file.writeFile(value, "utf8"); await file.sync(); } finally { await file.close(); }
    }
  } catch {
    throw new HostError("STORAGE_IO_FAILED", 503, "Draft writing failed. Partial output is retained; use a new name after inspecting it.");
  }
  return { draftPath, draftName: name, report: model.report };
}
