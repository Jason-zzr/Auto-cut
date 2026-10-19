import { useEffect, useRef, useState } from "react";
import { AUTOMATIC_CAPTION_MODEL_ID, AUTOMATIC_CAPTION_MODEL_REVISION, YOLOS_TINY_MODEL_ID, YOLOS_TINY_MODEL_REVISION } from "../config/models.js";
import { SILERO_SPEECH_SEGMENTATION } from "../config/sileroVad.js";
import { SCENE_DETECT_TOOL_ID, SCENE_DETECT_TOOL_REVISION } from "../config/sceneDetect.js";

const labels = { speech: "语音转写", scene: "镜头分段", visual: "场景、运动与画质", detection: "主体检测", description: "画面描述" };
const statuses = { queued: "等待执行", running: "分析中", cancel_requested: "正在取消", cancelled: "已取消", interrupted: "已中断", failed: "失败", succeeded: "结果已保存" };
const models = {
  speech: { id: AUTOMATIC_CAPTION_MODEL_ID, revision: AUTOMATIC_CAPTION_MODEL_REVISION, precision: "q8", runtime: "transformers.js-3.8.1-wasm" },
  scene: { id: SCENE_DETECT_TOOL_ID, revision: SCENE_DETECT_TOOL_REVISION, precision: "cpu", runtime: "host-python-pyscenedetect" },
  visual: { id: "auto-edit-frame-metrics", revision: "9ad65c06a30519f8f1db7bad3182843c23b914c6", precision: "js", runtime: "browser-worker" },
  detection: { id: YOLOS_TINY_MODEL_ID, revision: YOLOS_TINY_MODEL_REVISION, precision: "q8", runtime: "transformers.js-3.8.1-wasm" },
  description: { id: "browser-language-model", revision: null, precision: "browser-managed", runtime: "browser-language-model" },
};

function replaceSemanticEvidence(content, removed, added) {
  const replace = values => [...new Set(values.flatMap(value => removed.includes(value) ? added : [value]))];
  return { ...content, themes: content.themes.map(theme => ({ ...theme, evidenceSegmentIds: replace(theme.evidenceSegmentIds) })),
    centralIdea: content.centralIdea ? { ...content.centralIdea, evidenceSegmentIds: replace(content.centralIdea.evidenceSegmentIds) } : null };
}

export function MaterialAnalysisPanel({ analysis, assets }) {
  const latest = useRef(null);
  const [ranges, setRanges] = useState({}), [capabilities, setCapabilities] = useState(["speech"]);
  const [force, setForce] = useState(false), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]), [chosen, setChosen] = useState(null), [correction, setCorrection] = useState(null);
  const [semanticResults, setSemanticResults] = useState([]), [semanticChosen, setSemanticChosen] = useState(null), [semanticCorrection, setSemanticCorrection] = useState(null);
  const [component, setComponent] = useState(null), [preview, setPreview] = useState(null);
  const [visualStatus, setVisualStatus] = useState(null), [visualQuery, setVisualQuery] = useState("");
  const [visualResults, setVisualResults] = useState([]), [visualRunning, setVisualRunning] = useState(false);
  const player = useRef(null);
  useEffect(() => {
    if (player.current?.readyState >= 1) {
      player.current.pause();
      player.current.currentTime = preview?.range?.sourceStartSeconds ?? 0;
    }
  }, [preview]);
  const refresh = async () => {
    const collected = [], semantics = [];
    for (const asset of assets) {
      let cursor;
      do { const page = await analysis.list(asset.assetId, cursor); collected.push(...page.items); cursor = page.cursor; } while (cursor);
      cursor = undefined;
      do { const page = await analysis.semanticList(asset.assetId, cursor); semantics.push(...page.items); cursor = page.cursor; } while (cursor);
    }
    setResults(collected); setSemanticResults(semantics); await analysis.refresh();
    const [nextComponent, nextVisualStatus] = await Promise.all([analysis.component(), analysis.visualStatus()]);
    setComponent(nextComponent); setVisualStatus(nextVisualStatus);
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
    setCorrection(structuredClone(item.correction?.correction || (item.raw.basis.capability === "scene"
      ? { text: "", intervals: item.raw.output.scenes.map(scene => ({ range: scene.range, text: "", labels: [], visualNotes: "" })) }
      : { text: item.raw.output.text, intervals: [{ range: item.raw.basis.range, text: item.raw.output.text, labels: [], visualNotes: "" }] })));
  };
  const chooseSemantic = item => {
    const output = item.correction?.output || item.raw.output;
    setSemanticChosen(item);
    setSemanticCorrection(structuredClone({ segments: output.segments.map(({ range: _range, originalText: _text, ...segment }) => segment),
      themes: output.themes, centralIdea: output.centralIdea, complete: output.complete, limitations: output.limitations }));
  };
  const semanticRange = segment => {
    const selected = semanticChosen?.raw.units.slice(segment.unitStart, segment.unitEnd) || [];
    return selected.length ? { sourceStartSeconds: selected[0].range.sourceStartSeconds,
      sourceEndSeconds: selected[selected.length - 1].range.sourceEndSeconds } : semanticChosen?.raw.basis.range;
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
        if ((asset.kind === "image" && (capability === "speech" || capability === "scene")) || (asset.kind === "audio" && capability !== "speech")) continue;
        inputs.push({ assetRef: { kind: "asset", entityId: asset.assetId, revision: asset.revision }, mediaRef: asset.mediaRef,
          contentSha256: asset.sha256, range, capability, model: models[capability], settings: { language: "zh", sampleIntervalSeconds: 1,
            ...(capability === "speech" ? { speechSegmentation: { ...SILERO_SPEECH_SEGMENTATION } } : {}),
            ...(capability === "scene" ? { sceneDetection: { backend: "pyscenedetect", method: "content", threshold: 27, minSceneLengthSeconds: 1, toolRevision: SCENE_DETECT_TOOL_REVISION } } : {}) } });
      }
    }
    if (!inputs.length) throw new Error("请选择适用于当前素材的分析能力。");
    await analysis.start(event, { inputs, force });
  };
  const play = async (asset, range) => {
    const src = await analysis.source(asset);
    setPreview({ asset, src, range });
  };
  const buildVisualIndex = async event => {
    setVisualRunning(true); setError("");
    try { await analysis.buildVisualIndex(event); await refresh(); }
    catch (failure) { setError(failure.message); }
    finally { setVisualRunning(false); }
  };
  const searchVisual = async () => {
    const query = visualQuery.trim();
    if (!query) throw new Error("请输入要查找的画面描述。");
    const result = await analysis.visualQuery({ query, k: 10, diversity: 0.2 });
    setVisualResults(result.items);
  };
  const busy = loading || analysis.running || visualRunning;
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
        (basis.capability === "scene" && (!basis.settings.sceneDetection || basis.settings.sceneDetection.backend !== "pyscenedetect" ||
          basis.settings.sceneDetection.method !== "content" || basis.settings.sceneDetection.threshold !== 27 ||
          basis.settings.sceneDetection.minSceneLengthSeconds !== 1 || basis.settings.sceneDetection.toolRevision !== SCENE_DETECT_TOOL_REVISION)) ||
        (basis.capability === "speech" && Object.entries(SILERO_SPEECH_SEGMENTATION).some(([field, value]) => basis.settings.speechSegmentation?.[field] !== value)) ||
        (asset.kind !== "image" && selected?.start !== undefined && Number(selected.start) !== basis.range.sourceStartSeconds) ||
        (asset.kind !== "image" && selected?.end !== undefined && selected.end !== "" && Number(selected.end) !== basis.range.sourceEndSeconds);
      return <li key={item.raw.analysisId}><div>{asset?.name}
      <small>{labels[item.raw.basis.capability]} · {item.raw.basis.range.sourceStartSeconds}–{item.raw.basis.range.sourceEndSeconds} 秒 ·
        {item.raw.output.complete ? "完整" : `部分结果：${item.raw.output.missingCapabilities.join("、")}`} {basis.capability === "scene" ? `· ${item.raw.output.scenes.length} 个镜头` : ""} · {item.correction ? `人工修订 ${item.correction.revision}` : "原始结果"}</small></div>
      {basisChanged ? <p role="status">依据已变化，当前选择需重新分析；旧结果和人工修订仍保留。</p> : null}
      <button onClick={() => choose(item)}>查看与校订</button></li>;
    })}</ul>
    {chosen && correction ? <div className="analysis-correction">
      <details><summary>原始分析与来源</summary><pre>{JSON.stringify(chosen.raw, null, 2)}</pre></details>
      {chosen.raw.basis.capability !== "scene" ? <label>校订文本<textarea value={correction.text} onChange={event => setCorrection(value => ({ ...value, text: event.target.value }))} /></label> : null}
      {correction.intervals.map((interval, index) => <fieldset key={index} disabled={loading}>
        <legend>源区间 {index + 1}</legend>
        {[["sourceStartSeconds", "起点"], ["sourceEndSeconds", "终点"]].map(([field, label]) => <label key={field}>{label}（秒）
          <input type="number" min={chosen.raw.basis.range.sourceStartSeconds} max={chosen.raw.basis.range.sourceEndSeconds} step="0.001"
            value={interval.range[field]} onChange={event => setCorrection(value => ({ ...value, intervals: value.intervals.map((item, position) => position === index
              ? { ...item, range: { ...item.range, [field]: Number(event.target.value) } } : item) }))} /></label>)}
        {chosen.raw.basis.capability !== "scene" ? <>
          <label>区间文本<textarea value={interval.text} onChange={event => setCorrection(value => ({ ...value, intervals: value.intervals.map((item, position) => position === index ? { ...item, text: event.target.value } : item) }))} /></label>
          <label>多标签（每行一个）<textarea value={interval.labels.join("\n")} onChange={event => setCorrection(value => ({ ...value, intervals: value.intervals.map((item, position) => position === index ? { ...item, labels: event.target.value.split("\n") } : item) }))} /></label>
          <label>画面备注<textarea value={interval.visualNotes} onChange={event => setCorrection(value => ({ ...value, intervals: value.intervals.map((item, position) => position === index ? { ...item, visualNotes: event.target.value } : item) }))} /></label>
        </> : null}
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
    <h4>逐段语义摘要与素材中心思想</h4>
    <p>由连接的 Agent 通过语义分析工具处理已保存的语音转写；摘要引用原文修订，不上传原音视频。</p>
    <ul>{semanticResults.map(item => {
      const output = item.correction?.output || item.raw.output;
      const asset = assets.find(value => value.assetId === item.raw.basis.assetRef.entityId);
      return <li key={item.raw.analysisId}><div><strong>{asset?.name || item.raw.basis.assetRef.entityId}</strong>
        <small>{output.segments.length} 个语义段 · {output.themes.length} 个分主题 · {item.correction ? `人工修订 ${item.correction.revision}` : "Agent 原始结果"}</small></div>
        <p>{output.centralIdea?.summary || "未形成单一中心思想"}</p>
        {!item.sourceCurrent ? <p role="status">原文修订已变化，此结果作为历史保留；请基于当前转写重新提炼。</p> : null}
        <button onClick={() => chooseSemantic(item)}>查看证据与校订</button></li>;
    })}</ul>
    {semanticChosen && semanticCorrection ? <div className="analysis-correction">
      <details><summary>语义分析依据</summary><pre>{JSON.stringify(semanticChosen.raw.basis, null, 2)}</pre></details>
      {semanticCorrection.centralIdea ? <label>中心思想<textarea value={semanticCorrection.centralIdea.summary}
        onChange={event => setSemanticCorrection(value => ({ ...value, centralIdea: { ...value.centralIdea, summary: event.target.value } }))} /></label>
        : <p>当前结果没有强制生成单一中心思想。</p>}
      <fieldset disabled={loading}>
        <legend>分主题</legend>
        {semanticCorrection.themes.length ? semanticCorrection.themes.map((theme, index) => <div key={theme.themeId}>
          <label>主题名称<input value={theme.title} onChange={event => setSemanticCorrection(value => ({ ...value,
            themes: value.themes.map((item, position) => position === index ? { ...item, title: event.target.value } : item) }))} /></label>
          <label>主题概括<textarea value={theme.summary} onChange={event => setSemanticCorrection(value => ({ ...value,
            themes: value.themes.map((item, position) => position === index ? { ...item, summary: event.target.value } : item) }))} /></label>
          <small>依据语义段：{theme.evidenceSegmentIds.join("、")}</small>
        </div>) : <p>当前结果没有分主题。</p>}
      </fieldset>
      {semanticCorrection.segments.map((segment, index) => {
        const original = semanticChosen.raw.units.slice(segment.unitStart, segment.unitEnd).map(unit => unit.text).join(semanticChosen.raw.basis.sourceKind === "words" ? "" : "\n");
        return <fieldset key={segment.segmentId} disabled={loading}>
          <legend>语义段 {index + 1}</legend>
          <label>原文单元起点<input type="number" min="0" max={semanticChosen.raw.units.length - 1} value={segment.unitStart}
            onChange={event => setSemanticCorrection(value => ({ ...value, segments: value.segments.map((item, position) => position === index ? { ...item, unitStart: Number(event.target.value) } : item) }))} /></label>
          <label>原文单元终点（不含）<input type="number" min="1" max={semanticChosen.raw.units.length} value={segment.unitEnd}
            onChange={event => setSemanticCorrection(value => ({ ...value, segments: value.segments.map((item, position) => position === index ? { ...item, unitEnd: Number(event.target.value) } : item) }))} /></label>
          <label>对应原文<textarea readOnly value={original} /></label>
          <label>这段话表达的意思<textarea value={segment.summary} onChange={event => setSemanticCorrection(value => ({ ...value,
            segments: value.segments.map((item, position) => position === index ? { ...item, summary: event.target.value } : item) }))} /></label>
          <label>待核实或歧义<textarea value={segment.uncertainty} onChange={event => setSemanticCorrection(value => ({ ...value,
            segments: value.segments.map((item, position) => position === index ? { ...item, uncertainty: event.target.value } : item) }))} /></label>
          <button onClick={() => perform(() => play(assets.find(asset => asset.assetId === semanticChosen.raw.basis.assetRef.entityId), semanticRange(segment)))}>回放原文区间</button>
          {segment.unitEnd - segment.unitStart > 1 ? <button onClick={() => setSemanticCorrection(value => {
            const current = value.segments[index], middle = current.unitStart + Math.floor((current.unitEnd - current.unitStart) / 2);
            const secondId = `${current.segmentId}-split-${crypto.randomUUID()}`;
            const next = replaceSemanticEvidence(value, [current.segmentId], [current.segmentId, secondId]);
            return { ...next, segments: [...value.segments.slice(0, index), { ...current, unitEnd: middle },
              { ...current, segmentId: secondId, unitStart: middle }, ...value.segments.slice(index + 1)] };
          })}>在中点拆分</button> : null}
          {index > 0 ? <button onClick={() => setSemanticCorrection(value => {
            const previous = value.segments[index - 1], current = value.segments[index];
            const next = replaceSemanticEvidence(value, [previous.segmentId, current.segmentId], [previous.segmentId]);
            return { ...next, segments: [...value.segments.slice(0, index - 1), { ...previous, unitEnd: current.unitEnd,
              summary: [previous.summary, current.summary].filter(Boolean).join("；"),
              uncertainty: [previous.uncertainty, current.uncertainty].filter(Boolean).join("；") }, ...value.segments.slice(index + 1)] };
          })}>与上一段合并</button> : null}
        </fieldset>;
      })}
      <label>局限说明（每行一项）<textarea value={semanticCorrection.limitations.join("\n")}
        onChange={event => setSemanticCorrection(value => ({ ...value, limitations: event.target.value.split("\n").map(item => item.trim()).filter(Boolean) }))} /></label>
      <button disabled={busy} onClick={event => perform(async () => {
        const segments = semanticCorrection.segments;
        if (!segments.length || segments[0].unitStart !== 0 || segments.at(-1).unitEnd !== semanticChosen.raw.units.length ||
            segments.some((segment, index) => segment.unitEnd <= segment.unitStart || index > 0 && segment.unitStart !== segments[index - 1].unitEnd)) {
          throw new Error("语义段必须连续覆盖全部原文单元，且不能重叠或留空。");
        }
        await analysis.correctSemantic(event, semanticChosen.raw.analysisId, semanticChosen.correction?.revision ?? 1, semanticCorrection);
        setSemanticChosen(null); await refresh();
      })}>保存语义修订</button>
    </div> : null}
    <h4>项目素材视觉检索</h4>
    <p>只索引当前已保存的镜头区间。向量写入本机可重建缓存；检索结果只提供可回放来源候选，不自动生成或确认脚本。</p>
    {visualStatus?.component.state === "missing" ? <p role="status">视觉组件未随当前应用提供；不会联网下载模型。请使用包含已审阅视觉组件的发行包。</p> : null}
    <p role="status">已登记镜头：{visualStatus?.sceneCount ?? 0}；索引：{visualStatus?.cache.state === "ready"
      ? `${visualStatus.cache.rows} 个区间` : "未建立或依据已变化"}</p>
    <button disabled={loading || analysis.running || visualRunning || visualStatus?.component.state !== "verified" || !visualStatus?.sceneCount}
      onClick={buildVisualIndex}>建立当前镜头索引</button>
    {visualRunning || visualStatus?.running ? <button onClick={event => analysis.cancelVisualIndex(event).catch(failure => setError(failure.message))}>取消索引</button> : null}
    <label>画面描述<input value={visualQuery} maxLength={2000} placeholder="例如：雨中沿山路行走的人"
      onChange={event => setVisualQuery(event.target.value)} /></label>
    <button disabled={busy || visualStatus?.cache.state !== "ready" || !visualQuery.trim()}
      onClick={() => perform(searchVisual)}>检索当前项目镜头</button>
    <ul>{visualResults.map(item => {
      const asset = assets.find(value => value.assetId === item.source.assetRef.entityId);
      return <li key={item.sourceId}><div><strong>{asset?.name || item.source.assetRef.entityId}</strong>
        <small>{item.source.range.sourceStartSeconds}–{item.source.range.sourceEndSeconds} 秒 · 得分 {item.score.toFixed(4)} · sourceId {item.sourceId}</small></div>
        {asset ? <button onClick={() => perform(() => play(asset, item.source.range))}>回放候选</button> : <span role="status">素材已变化，请刷新索引。</span>}</li>;
    })}</ul>
  </section>;
}
