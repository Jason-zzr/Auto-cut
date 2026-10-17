import { useEffect, useRef, useState } from "react";
import { AUTOMATIC_CAPTION_MODEL_ID, AUTOMATIC_CAPTION_MODEL_REVISION, YOLOS_TINY_MODEL_ID, YOLOS_TINY_MODEL_REVISION } from "../config/models.js";
import { SILERO_SPEECH_SEGMENTATION } from "../config/sileroVad.js";

const labels = { speech: "语音转写", visual: "场景、运动与画质", detection: "主体检测", description: "画面描述" };
const statuses = { queued: "等待执行", running: "分析中", cancel_requested: "正在取消", cancelled: "已取消", interrupted: "已中断", failed: "失败", succeeded: "结果已保存" };
const models = {
  speech: { id: AUTOMATIC_CAPTION_MODEL_ID, revision: AUTOMATIC_CAPTION_MODEL_REVISION, precision: "q8", runtime: "transformers.js-3.8.1-wasm" },
  visual: { id: "auto-edit-frame-metrics", revision: "9ad65c06a30519f8f1db7bad3182843c23b914c6", precision: "js", runtime: "browser-worker" },
  detection: { id: YOLOS_TINY_MODEL_ID, revision: YOLOS_TINY_MODEL_REVISION, precision: "q8", runtime: "transformers.js-3.8.1-wasm" },
  description: { id: "browser-language-model", revision: null, precision: "browser-managed", runtime: "browser-language-model" },
};

export function MaterialAnalysisPanel({ analysis, assets }) {
  const latest = useRef(null);
  const [ranges, setRanges] = useState({}), [capabilities, setCapabilities] = useState(["speech"]);
  const [force, setForce] = useState(false), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]), [chosen, setChosen] = useState(null), [correction, setCorrection] = useState(null);
  const [component, setComponent] = useState(null), [preview, setPreview] = useState(null);
  const player = useRef(null);
  useEffect(() => {
    if (player.current?.readyState >= 1) {
      player.current.pause();
      player.current.currentTime = preview?.range?.sourceStartSeconds ?? 0;
    }
  }, [preview]);
  const refresh = async () => {
    const collected = [];
    for (const asset of assets) {
      let cursor;
      do { const page = await analysis.list(asset.assetId, cursor); collected.push(...page.items); cursor = page.cursor; } while (cursor);
    }
    setResults(collected); await analysis.refresh(); setComponent(await analysis.component());
  };
  const perform = async action => {
    setLoading(true); setError("");
    try { await action(); }
    catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  };
  latest.current = refresh;
  useEffect(() => {
    if (analysis.running) return;
    let active = true;
    latest.current().catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [analysis.running]);
  const choose = item => {
    setChosen(item);
    setCorrection(structuredClone(item.correction?.correction || { text: item.raw.output.text,
      intervals: [{ range: item.raw.basis.range, text: item.raw.output.text, labels: [], visualNotes: "" }] }));
  };
  const start = async event => {
    const inputs = [];
    for (const asset of assets) {
      const range = asset.kind === "image" ? { sourceStartSeconds: 0, sourceEndSeconds: 0 } : {
        sourceStartSeconds: Number(ranges[asset.assetId]?.start ?? 0), sourceEndSeconds: Number(ranges[asset.assetId]?.end),
      };
      if (!Number.isFinite(range.sourceEndSeconds) || range.sourceStartSeconds < 0 ||
          (asset.kind !== "image" && range.sourceEndSeconds <= range.sourceStartSeconds)) throw new Error(`请填写「${asset.name}」有效的源起止时间。`);
      for (const capability of capabilities) {
        if ((asset.kind === "image" && capability === "speech") || (asset.kind === "audio" && capability !== "speech")) continue;
        inputs.push({ assetRef: { kind: "asset", entityId: asset.assetId, revision: asset.revision }, mediaRef: asset.mediaRef,
          contentSha256: asset.sha256, range, capability, model: models[capability], settings: { language: "zh", sampleIntervalSeconds: 1,
            ...(capability === "speech" ? { speechSegmentation: { ...SILERO_SPEECH_SEGMENTATION } } : {}) } });
      }
    }
    if (!inputs.length) throw new Error("请选择适用于当前素材的分析能力。");
    await analysis.start(event, { inputs, force });
  };
  const play = async (asset, range) => {
    const src = await analysis.source(asset);
    setPreview({ asset, src, range });
  };
  const busy = loading || analysis.running;
  return <section className="material-analysis" aria-label="素材分析">
    <h3>素材分析（{assets.length} 份素材）</h3>
    {error || analysis.error ? <p role="alert">{error || analysis.error}</p> : null}
    {analysis.phase ? <p role="status">{analysis.phase}</p> : null}
    <div className="project-storage-toolbar">
      <button disabled={loading} onClick={() => perform(refresh)}>刷新分析与组件</button>
      {component?.state === "missing" ? <button disabled={busy} onClick={event => perform(() => analysis.prepareComponent(event))}>准备本机 Whisper 组件</button> : null}
      <button disabled={busy} onClick={event => perform(() => analysis.prepareComponent(event, "yolos-tiny-q8"))}>准备本机主体检测组件</button>
      <button disabled={busy} onClick={event => perform(() => analysis.prepareComponent(event, "silero-vad"))}>准备本机语音检测组件</button>
      {component?.state === "preparing" ? <span>组件准备中：{Math.round(component.receivedBytes / 1024 / 1024)} MiB</span> : null}
      {component?.error ? <p role="alert">{component.error}</p> : null}
      {analysis.pendingSave || analysis.unresolved ? <button disabled={busy} onClick={event => perform(() => analysis.retrySave(event))}>确认或补登记上次保存</button> : null}
    </div>
    <fieldset disabled={busy}>
      <legend>分析能力</legend>
      {Object.entries(labels).map(([value, label]) => <label key={value}><input type="checkbox" checked={capabilities.includes(value)}
        onChange={event => setCapabilities(current => event.target.checked ? [...current, value] : current.filter(item => item !== value))} />{label}</label>)}
      <label><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />重新分析并保留旧结果</label>
    </fieldset>
    {assets.map(asset => <div className="analysis-source" key={asset.assetId}>
      <strong>{asset.name}</strong>
      {asset.kind !== "image" ? <>
        <label>源起点（秒）<input type="number" min="0" step="0.001" disabled={busy} value={ranges[asset.assetId]?.start ?? "0"}
          onChange={event => setRanges(values => ({ ...values, [asset.assetId]: { ...values[asset.assetId], start: event.target.value } }))} /></label>
        <label>源终点（秒）<input type="number" min="0" step="0.001" disabled={busy} value={ranges[asset.assetId]?.end ?? ""}
          onChange={event => setRanges(values => ({ ...values, [asset.assetId]: { ...values[asset.assetId], end: event.target.value } }))} /></label>
      </> : null}
      <button disabled={loading} onClick={() => perform(() => play(asset, null))}>查看源素材</button>
    </div>)}
    <button disabled={busy || !assets.length || !capabilities.length || Boolean(analysis.pendingSave) || analysis.unresolved}
      onClick={event => perform(() => start(event))}>开始分析</button>
    {analysis.running ? <button onClick={event => perform(() => analysis.cancel(event))}>取消当前分析</button> : null}
    {preview ? <div className="analysis-preview">
      {preview.asset.kind === "image" ? <img src={preview.src} alt={preview.asset.name} /> :
        <video ref={player} src={preview.src} controls preload="metadata" onLoadedMetadata={event => {
          const duration = event.currentTarget.duration;
          if (Number.isFinite(duration)) setRanges(values => ({ ...values, [preview.asset.assetId]: { start: "0", end: String(duration), ...values[preview.asset.assetId] } }));
          if (preview.range) event.currentTarget.currentTime = preview.range.sourceStartSeconds;
        }} onTimeUpdate={event => {
          if (preview.range && event.currentTarget.currentTime >= preview.range.sourceEndSeconds) {
            event.currentTarget.pause();
            if (event.currentTarget.currentTime > preview.range.sourceEndSeconds) event.currentTarget.currentTime = preview.range.sourceEndSeconds;
          }
        }} />}
    </div> : null}
    <ul>{analysis.tasks.flatMap(task => task.steps.map(step => <li key={step.stepId}>
      <div><strong>{assets.find(asset => asset.assetId === step.basis.assetRef.entityId)?.name || step.basis.assetRef.entityId}</strong>
        <small>{labels[step.basis.capability]} · {statuses[step.status]} · {step.checkpoints.length} 个已保存区间</small>
        {step.error ? <span role="alert">{step.error.message}</span> : null}</div>
      {["queued", "interrupted", "failed", "cancelled"].includes(step.status) ? <button disabled={busy || Boolean(analysis.pendingSave) || analysis.unresolved}
        onClick={event => perform(() => analysis.continueTask(event, task.taskId, step.status === "queued" ? null : step.stepId))}>继续剩余区间</button> : null}
    </li>))}</ul>
    <h4>已保存结果</h4>
    <ul>{results.map(item => {
      const basis = item.raw.basis;
      const asset = assets.find(value => value.assetId === basis.assetRef.entityId);
      const selected = ranges[basis.assetRef.entityId];
      const basisChanged = !asset || asset.revision !== basis.assetRef.revision || asset.sha256 !== basis.contentSha256 ||
        ["kind", "entityId", "blobId"].some(field => asset.mediaRef[field] !== basis.mediaRef[field]) ||
        Object.entries(models[basis.capability]).some(([field, value]) => basis.model[field] !== value) ||
        basis.settings.language !== "zh" || basis.settings.sampleIntervalSeconds !== 1 ||
        (basis.capability === "speech" && Object.entries(SILERO_SPEECH_SEGMENTATION).some(([field, value]) => basis.settings.speechSegmentation?.[field] !== value)) ||
        (asset.kind !== "image" && selected?.start !== undefined && Number(selected.start) !== basis.range.sourceStartSeconds) ||
        (asset.kind !== "image" && selected?.end !== undefined && selected.end !== "" && Number(selected.end) !== basis.range.sourceEndSeconds);
      return <li key={item.raw.analysisId}><div>{asset?.name}
      <small>{labels[item.raw.basis.capability]} · {item.raw.basis.range.sourceStartSeconds}–{item.raw.basis.range.sourceEndSeconds} 秒 ·
        {item.raw.output.complete ? "完整" : `部分结果：${item.raw.output.missingCapabilities.join("、")}`} · {item.correction ? `人工修订 ${item.correction.revision}` : "原始结果"}</small></div>
      {basisChanged ? <p role="status">依据已变化，当前选择需重新分析；旧结果和人工修订仍保留。</p> : null}
      <button onClick={() => choose(item)}>查看与校订</button></li>;
    })}</ul>
    {chosen && correction ? <div className="analysis-correction">
      <details><summary>原始分析与来源</summary><pre>{JSON.stringify(chosen.raw, null, 2)}</pre></details>
      <label>校订文本<textarea value={correction.text} onChange={event => setCorrection(value => ({ ...value, text: event.target.value }))} /></label>
      {correction.intervals.map((interval, index) => <fieldset key={index} disabled={loading}>
        <legend>源区间 {index + 1}</legend>
        {[["sourceStartSeconds", "起点"], ["sourceEndSeconds", "终点"]].map(([field, label]) => <label key={field}>{label}（秒）
          <input type="number" min={chosen.raw.basis.range.sourceStartSeconds} max={chosen.raw.basis.range.sourceEndSeconds} step="0.001"
            value={interval.range[field]} onChange={event => setCorrection(value => ({ ...value, intervals: value.intervals.map((item, position) => position === index
              ? { ...item, range: { ...item.range, [field]: Number(event.target.value) } } : item) }))} /></label>)}
        <label>区间文本<textarea value={interval.text} onChange={event => setCorrection(value => ({ ...value, intervals: value.intervals.map((item, position) => position === index ? { ...item, text: event.target.value } : item) }))} /></label>
        <label>多标签（每行一个）<textarea value={interval.labels.join("\n")} onChange={event => setCorrection(value => ({ ...value, intervals: value.intervals.map((item, position) => position === index ? { ...item, labels: event.target.value.split("\n") } : item) }))} /></label>
        <label>画面备注<textarea value={interval.visualNotes} onChange={event => setCorrection(value => ({ ...value, intervals: value.intervals.map((item, position) => position === index ? { ...item, visualNotes: event.target.value } : item) }))} /></label>
        <button onClick={() => perform(() => play(assets.find(asset => asset.assetId === chosen.raw.basis.assetRef.entityId), interval.range))}>回放此源区间</button>
        <button onClick={() => setCorrection(value => ({ ...value, intervals: value.intervals.filter((_, position) => position !== index) }))}>移除此区间</button>
      </fieldset>)}
      <button onClick={() => setCorrection(value => ({ ...value, intervals: [...value.intervals, { range: chosen.raw.basis.range, text: "", labels: [], visualNotes: "" }] }))}>添加区间</button>
      <button disabled={busy} onClick={event => perform(async () => {
        const normalized = { ...correction, intervals: correction.intervals.map(item => ({ ...item, labels: [...new Set(item.labels.map(label => label.trim()).filter(Boolean))] })) };
        if (normalized.intervals.some(item => item.range.sourceEndSeconds < item.range.sourceStartSeconds)) throw new Error("区间终点不能早于起点。");
        await analysis.correct(event, chosen.raw.analysisId, chosen.correction?.revision ?? 1, normalized); setChosen(null); await refresh();
      })}>保存人工修订</button>
    </div> : null}
  </section>;
}
