import { useEffect, useRef, useState } from "react";
import { useMiganRepair } from "./useMiganRepair.js";
import { validateMiganRegions } from "../lib/miganRepairRegions.js";

export function useRepairRegionSelection({ visualSegments, visualOverlaySegments, assets, notify, t }) {
  const [request, setRequest] = useState(null);
  const current = useRef(null);
  const imageUrlRefs = useRef(new Set());
  const repair = useMiganRepair({ selectedSegment: request?.segment, imageUrlRefs, notify, t });
  const findClip = id => [...visualSegments, ...visualOverlaySegments].find(clip => clip.id === id);
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const inspect = requestId => {
    const value = current.current;
    if (!value || value.requestId !== requestId) fail("INVALID_ARGUMENT");
    if (["pending", "selected"].includes(value.status) && (findClip(value.clipId) !== value.segment
      || assets.find(asset => (asset.assetId || asset.id) === value.assetId)?.blob !== value.segment.blob)) {
      current.current = { ...value, status: "stale", regions: undefined };
      setRequest(current.current);
    }
    const result = current.current;
    return { requestId, clipId: result.clipId, assetId: result.assetId, status: result.status,
      ...(result.status === "selected" ? { regions: structuredClone(result.regions) } : {}), inferenceStarted: false, timelineChanged: false };
  };
  const open = ({ requestId, clipId, assetId }) => {
    if (current.current?.requestId === requestId) {
      if (current.current.clipId !== clipId || current.current.assetId !== assetId) fail("INVALID_ARGUMENT");
      return inspect(requestId);
    }
    if (current.current?.status === "pending") fail("EDITOR_BUSY");
    const segment = findClip(clipId);
    const asset = assets.find(asset => (asset.assetId || asset.id) === assetId);
    if (!segment || !["image", "video"].includes(segment.type) || !segment.src || !(segment.blob instanceof Blob)
      || !asset || asset.blob !== segment.blob || asset.preparing) fail("AI_INVALID_SOURCE");
    if (segment.type === "video" && (segment.speedCurve?.enabled || segment.reverse || segment.reversed)) fail("AI_INVALID_SOURCE");
    current.current = { requestId, clipId, assetId, segment, status: "pending" };
    setRequest(current.current);
    return inspect(requestId);
  };
  useEffect(() => {
    if (request?.status === "pending") repair.openDialog({ resetRegions: true });
  }, [request?.requestId]);
  useEffect(() => {
    if (current.current && ["pending", "selected"].includes(current.current.status)) inspect(current.current.requestId);
  }, [visualSegments, visualOverlaySegments, assets]);
  const cancel = () => {
    if (current.current?.status !== "pending") return;
    current.current = { ...current.current, status: "cancelled" };
    setRequest(current.current);
    repair.closeDialog();
  };
  const confirm = event => {
    if (!event?.isTrusted || !current.current || inspect(current.current.requestId).status !== "pending") return;
    const segment = current.current.segment;
    const regions = repair.regions.map(region => ({ selection: { ...region.selection }, ...(segment.type === "video"
      ? { start: region.start, end: region.end, keyframes: structuredClone(region.keyframes || []) } : {}) }));
    try {
      validateMiganRegions(regions, segment.type === "video", segment.duration);
      current.current = { ...current.current, status: "selected", regions };
      setRequest(current.current);
      repair.closeDialog();
    } catch (error) { notify(error.message); }
  };
  return { open, inspect, confirm, segment: request?.segment,
    repair: { ...repair, dialogOpen: request?.status === "pending" && repair.dialogOpen, closeDialog: cancel } };
}
