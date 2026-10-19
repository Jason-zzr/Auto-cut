import { useMemo } from "react";

import {
  EMPTY_VISION_OPTIONS,
  getObjectPositionForCrop,
} from "../lib/editorRuntime.js";
import { resolveCaptionAvoidance } from "../lib/captionLayout.js";
import { resolveSmartFrameCropAtTime, smartFrameCropToPixels } from "../lib/smartFrame.js";
import { resolveVisionAnalysisAtTime } from "../lib/vision.js";

export function usePreviewModel(d) {
  const previewVisionAnalysis = useMemo(
    () => resolveVisionAnalysisAtTime(
      d.previewVisionBaseAnalysis,
      d.previewVisualType === "video" ? d.previewVideoMediaTime : d.previewVisualSourceTime,
    ),
    [
      d.previewVideoMediaTime, d.previewVisionBaseAnalysis, d.previewVisualSourceTime,
      d.previewVisualType,
    ],
  );
  const previewVisionOptions = d.previewVisionRecord?.options ?? EMPTY_VISION_OPTIONS;
  const previewVisionFrameSize = useMemo(() => ({
    width: d.previewFrameSize.width || (360 * d.ratio.width) / d.ratio.height,
    height: d.previewFrameSize.height || 360,
  }), [d.previewFrameSize.height, d.previewFrameSize.width, d.ratio.height, d.ratio.width]);
  const previewSmartCropRect = useMemo(() => {
    const smartFrame = d.previewSmartFrameOverride === false
      ? null
      : d.previewSmartFrameOverride || d.previewVisualSegment?.smartFrame;
    const crop = resolveSmartFrameCropAtTime(smartFrame, d.previewVisualSourceTime);
    return crop ? smartFrameCropToPixels(crop, smartFrame.sourceSize) : null;
  }, [d.previewSmartFrameOverride, d.previewVisualSegment?.smartFrame, d.previewVisualSourceTime]);
  const captionAvoidance = useMemo(() => resolveCaptionAvoidance({
    vision: previewVisionAnalysis ? { ...previewVisionAnalysis, options: previewVisionOptions } : null,
    frameSize: previewVisionFrameSize,
    sourceSize: previewVisionAnalysis?.sourceSize,
    fitMode: previewSmartCropRect?.presentation === "safe-contain" ? "contain" : previewSmartCropRect ? "cover" : d.fitMode,
    smartCrop: previewSmartCropRect?.presentation === "safe-contain" ? null : previewSmartCropRect,
    basePlacement: d.captionPlacement,
    text: d.currentCaption,
    captionSize: d.captionSize,
    captionStyle: d.captionStyle,
    referenceFrame: previewVisionFrameSize,
  }), [
    d.captionPlacement, d.captionSize, d.captionStyle, d.currentCaption, d.fitMode,
    previewSmartCropRect, previewVisionAnalysis, previewVisionFrameSize, previewVisionOptions,
  ]);
  const effectiveCaptionPlacement = captionAvoidance.placement;
  const previewVisualRenderSrc =
    previewVisionOptions.removeBackground &&
    d.previewVisualType === "image" &&
    previewVisionAnalysis?.cutoutUrl
      ? previewVisionAnalysis.cutoutUrl
      : d.previewVisualSrc;
  const previewVisionMaskUrl =
    previewVisionOptions.removeBackground && d.previewVisualType === "video"
      ? previewVisionAnalysis?.cutoutUrl ?? ""
      : "";
  const previewVisualObjectFit = previewSmartCropRect?.presentation === "safe-contain"
    ? "contain"
    : previewSmartCropRect ? "cover" : d.fitMode;
  const previewVisualObjectPosition = previewSmartCropRect
    ? previewSmartCropRect.presentation === "safe-contain"
      ? "50% 50%"
      : getObjectPositionForCrop(previewSmartCropRect)
    : "50% 50%";
  const previewSmartBackgroundPosition = previewSmartCropRect
    ? getObjectPositionForCrop(previewSmartCropRect)
    : "50% 50%";

  return {
    captionAvoidanceActive: captionAvoidance.active, effectiveCaptionPlacement, previewSmartCropRect, previewVisionAnalysis,
    previewVisionFrameSize, previewVisionMaskUrl, previewVisionOptions,
    previewSmartBackgroundPosition, previewVisualObjectFit, previewVisualObjectPosition,
    previewVisualRenderSrc,
  };
}
