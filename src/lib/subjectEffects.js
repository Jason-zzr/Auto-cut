export const SUBJECT_EFFECT_PRESETS = Object.freeze([
  {
    id: "cyan-outline",
    kind: "person",
    titleKey: "effectPresetCyanOutline",
    hintKey: "effectPresetCyanOutlineHint",
    patch: {
      enabled: true,
      outline: { enabled: true, color: "#32ead8", width: 5, opacity: 1, softness: 0, glow: 0.38, glowRadius: 14 },
    },
  },
  {
    id: "white-sticker",
    kind: "person",
    titleKey: "effectPresetWhiteSticker",
    hintKey: "effectPresetWhiteStickerHint",
    patch: {
      enabled: true,
      outline: { enabled: true, color: "#ffffff", width: 9, opacity: 1, softness: 0, glow: 0.12, glowRadius: 7 },
    },
  },
  {
    id: "neon-pulse",
    kind: "person",
    titleKey: "effectPresetNeonPulse",
    hintKey: "effectPresetNeonPulseHint",
    patch: {
      enabled: true,
      outline: { enabled: true, color: "#ff4fc8", width: 4, opacity: 1, softness: 1, glow: 0.85, glowRadius: 24 },
    },
  },
  {
    id: "color-background",
    kind: "background",
    titleKey: "effectPresetColorBackground",
    hintKey: "effectPresetColorBackgroundHint",
    patch: {
      enabled: true,
      background: { mode: "color", color: "#17252b", fit: "cover", opacity: 1, blur: 18, darken: 0 },
    },
  },
  {
    id: "blur-background",
    kind: "background",
    titleKey: "effectPresetBlurBackground",
    hintKey: "effectPresetBlurBackgroundHint",
    patch: {
      enabled: true,
      background: { mode: "blur", color: "#111820", fit: "cover", opacity: 1, blur: 22, darken: 0.12 },
    },
  },
]);

export const DEFAULT_SUBJECT_EFFECT = Object.freeze({
  enabled: false,
  presetId: "",
  targetKind: "person",
  analysisQuality: "balanced",
  outline: {
    enabled: false,
    color: "#f3efe4",
    width: 12,
    opacity: 1,
    softness: 0,
    glow: 0.35,
    glowRadius: 14,
  },
  material: {
    id: "paper",
    textureScale: 1,
    textureStrength: 0.82,
    irregularity: 0.42,
    edgeDensity: 0.5,
    grain: 0.5,
    diffusion: 0.42,
    shadowDepth: 0.32,
    relief: 0.55,
    bleed: 0.48,
    contrast: 0.72,
    rings: 2,
    ringGap: 8,
  },
  background: {
    visible: true,
    mode: "original",
    color: "#17252b",
    src: "",
    assetId: "",
    fit: "cover",
    opacity: 1,
    blur: 20,
    darken: 0,
  },
  edge: {
    feather: 1,
    contract: 0,
    decontaminate: 0.25,
  },
});

const clamp = (value, minimum, maximum, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
};

export function normalizeSubjectEffect(value) {
  const effect = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_SUBJECT_EFFECT,
    ...effect,
    enabled: effect.enabled === true,
    targetKind: effect.targetKind === "object" ? "object" : "person",
    analysisQuality: ["fast", "balanced", "quality"].includes(effect.analysisQuality)
      ? effect.analysisQuality
      : DEFAULT_SUBJECT_EFFECT.analysisQuality,
    outline: {
      ...DEFAULT_SUBJECT_EFFECT.outline,
      ...(effect.outline || {}),
      enabled: effect.outline?.enabled === true,
      width: clamp(effect.outline?.width, 0, 32, DEFAULT_SUBJECT_EFFECT.outline.width),
      opacity: clamp(effect.outline?.opacity, 0, 1, DEFAULT_SUBJECT_EFFECT.outline.opacity),
      softness: clamp(effect.outline?.softness, 0, 20, DEFAULT_SUBJECT_EFFECT.outline.softness),
      glow: clamp(effect.outline?.glow, 0, 1, DEFAULT_SUBJECT_EFFECT.outline.glow),
      glowRadius: clamp(effect.outline?.glowRadius, 0, 60, DEFAULT_SUBJECT_EFFECT.outline.glowRadius),
    },
    material: {
      ...DEFAULT_SUBJECT_EFFECT.material,
      ...(effect.material || {}),
      id: ["paper", "frosted", "halo", "chrome", "impasto", "ink"].includes(effect.material?.id)
        ? effect.material.id
        : DEFAULT_SUBJECT_EFFECT.material.id,
      textureScale: clamp(effect.material?.textureScale, 0.35, 3, DEFAULT_SUBJECT_EFFECT.material.textureScale),
      textureStrength: clamp(effect.material?.textureStrength, 0, 1, DEFAULT_SUBJECT_EFFECT.material.textureStrength),
      irregularity: clamp(effect.material?.irregularity, 0, 1, DEFAULT_SUBJECT_EFFECT.material.irregularity),
      edgeDensity: clamp(effect.material?.edgeDensity, 0, 1, DEFAULT_SUBJECT_EFFECT.material.edgeDensity),
      grain: clamp(effect.material?.grain, 0, 1, DEFAULT_SUBJECT_EFFECT.material.grain),
      diffusion: clamp(effect.material?.diffusion, 0, 1, DEFAULT_SUBJECT_EFFECT.material.diffusion),
      shadowDepth: clamp(effect.material?.shadowDepth, 0, 1, DEFAULT_SUBJECT_EFFECT.material.shadowDepth),
      relief: clamp(effect.material?.relief, 0, 1, DEFAULT_SUBJECT_EFFECT.material.relief),
      bleed: clamp(effect.material?.bleed, 0, 1, DEFAULT_SUBJECT_EFFECT.material.bleed),
      contrast: clamp(effect.material?.contrast, 0, 1, DEFAULT_SUBJECT_EFFECT.material.contrast),
      rings: Math.round(clamp(effect.material?.rings, 1, 3, DEFAULT_SUBJECT_EFFECT.material.rings)),
      ringGap: clamp(effect.material?.ringGap, 2, 24, DEFAULT_SUBJECT_EFFECT.material.ringGap),
    },
    background: {
      ...DEFAULT_SUBJECT_EFFECT.background,
      ...(effect.background || {}),
      visible: effect.background?.visible !== false,
      mode: ["original", "color", "blur", "image", "video"].includes(effect.background?.mode)
        ? effect.background.mode
        : DEFAULT_SUBJECT_EFFECT.background.mode,
      src: typeof effect.background?.src === "string" ? effect.background.src : "",
      assetId: typeof effect.background?.assetId === "string" ? effect.background.assetId : "",
      fit: ["cover", "contain"].includes(effect.background?.fit)
        ? effect.background.fit
        : DEFAULT_SUBJECT_EFFECT.background.fit,
      opacity: clamp(effect.background?.opacity, 0, 1, DEFAULT_SUBJECT_EFFECT.background.opacity),
      blur: clamp(effect.background?.blur, 0, 80, DEFAULT_SUBJECT_EFFECT.background.blur),
      darken: clamp(effect.background?.darken, 0, 1, DEFAULT_SUBJECT_EFFECT.background.darken),
    },
    edge: {
      ...DEFAULT_SUBJECT_EFFECT.edge,
      ...(effect.edge || {}),
      feather: clamp(effect.edge?.feather, 0, 20, DEFAULT_SUBJECT_EFFECT.edge.feather),
      contract: clamp(effect.edge?.contract, -20, 20, DEFAULT_SUBJECT_EFFECT.edge.contract),
      decontaminate: clamp(effect.edge?.decontaminate, 0, 1, DEFAULT_SUBJECT_EFFECT.edge.decontaminate),
    },
  };
}

function mergePatch(base, patch) {
  return {
    ...base,
    ...patch,
    outline: { ...base.outline, ...(patch.outline || {}) },
    material: { ...base.material, ...(patch.material || {}) },
    background: { ...base.background, ...(patch.background || {}) },
    edge: { ...base.edge, ...(patch.edge || {}) },
  };
}

export function updateSubjectEffect(current, patch) {
  const base = normalizeSubjectEffect(current);
  const resolvedPatch = typeof patch === "function" ? patch(base) : patch;
  return normalizeSubjectEffect(mergePatch(base, resolvedPatch || {}));
}

export function applySubjectEffectPreset(current, presetId) {
  const preset = SUBJECT_EFFECT_PRESETS.find((item) => item.id === presetId);
  if (!preset) return normalizeSubjectEffect(current);
  return updateSubjectEffect(current, { ...preset.patch, presetId });
}

export function hasSubjectEffect(effect) {
  const normalized = normalizeSubjectEffect(effect);
  return normalized.enabled && (
    normalized.outline.enabled
    || normalized.background.visible === false
    || normalized.background.mode !== "original"
  );
}
