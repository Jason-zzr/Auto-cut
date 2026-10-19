import { MAX_TIMELINE_DURATION_SECONDS } from "../config/editor.js";

const time = { type: "number", minimum: 0, maximum: MAX_TIMELINE_DURATION_SECONDS };
const selection = { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: {
  x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 },
  width: { type: "number", minimum: 0.015, maximum: 1 }, height: { type: "number", minimum: 0.015, maximum: 1 },
} };
export const MIGAN_REGIONS_SCHEMA = { type: "array", minItems: 1, maxItems: 32, items: {
  type: "object", additionalProperties: false, required: ["selection"], properties: { selection, start: time, end: time,
    keyframes: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
      required: ["time", "selection"], properties: { time, selection } } },
  },
} };

export function validateMiganRegions(regions, video, duration) {
  const invalid = () => { throw Object.assign(new Error("Invalid MI-GAN repair regions"), { code: "INVALID_ARGUMENT" }); };
  const object = (value, keys) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  };
  const number = (value, minimum, maximum) => {
    if (!Number.isFinite(value) || value < minimum || value > maximum) invalid();
  };
  if (!Array.isArray(regions) || !regions.length || regions.length > 32) invalid();
  for (const region of regions) {
    object(region, ["selection", "start", "end", "keyframes"]);
    if (!video && ["start", "end", "keyframes"].some(key => region[key] !== undefined)) invalid();
    if (video) {
      number(region.start, 0, duration); number(region.end, Number.EPSILON, duration);
      if (region.end <= region.start) invalid();
    }
    const frames = region.keyframes ?? [];
    if (!Array.isArray(frames) || frames.length > 100) invalid();
    let previousTime = -1;
    for (const frame of frames) {
      object(frame, ["time", "selection"]);
      number(frame.time, region.start, region.end);
      if (frame.time <= previousTime) invalid();
      previousTime = frame.time;
    }
    for (const box of [region.selection, ...frames.map(frame => frame.selection)]) {
      object(box, ["x", "y", "width", "height"]);
      number(box.x, 0, 1); number(box.y, 0, 1);
      number(box.width, 0.015, 1); number(box.height, 0.015, 1);
      if (box.x + box.width > 1 || box.y + box.height > 1) invalid();
    }
  }
}
