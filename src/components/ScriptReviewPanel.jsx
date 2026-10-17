import { useEffect, useRef, useState } from "react";
import { PlanningControls } from "./PlanningControls.jsx";

export function ScriptReviewPanel({ review, analysis, assets, onBusyChange }) {
  const latest = useRef(review); latest.current = review;
  const [records, setRecords] = useState([]), [record, setRecord] = useState(null), [draft, setDraft] = useState(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState([]);
  const player = useRef(null), editSequence = useRef(0), saveAction = useRef(null);
  useEffect(() => { onBusyChange?.(dirty || loading || review.saving); }, [dirty, loading, review.saving, onBusyChange]);
  useEffect(() => {
    let active = true;
    latest.current.list().then(value => { if (active) setRecords(value.items); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  const select = item => { setRecord(item); setDraft(structuredClone(item.draft)); setDirty(false); setError(""); setHistory([]); };
  const change = update => { editSequence.current++; setDraft(update); setDirty(true); setError(""); };
  const save = async event => {
    const sequence = editSequence.current;
    setLoading(true); setError("");
    try {
      const saved = await review.save(record, draft, event);
      setRecord(saved); setRecords(values => [...values.filter(value => value.scriptId !== saved.scriptId), saved]);
      if (sequence === editSequence.current && saved.savedCurrentInput) { setDraft(structuredClone(saved.draft)); setDirty(false); }
    } catch (error) { setError(error.message); }
    finally { setLoading(false); }
  };
  saveAction.current = save;
  useEffect(() => {
    if (!dirty || loading || error) return;
    const timer = setTimeout(() => void saveAction.current(), 1000);
    return () => clearTimeout(timer);
  }, [draft, dirty, loading, error]);
  useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const create = async () => {
    setLoading(true); setError("");
    try {
      const { items: sources } = await review.sources();
      if (!sources.length) throw new Error("请先保存素材分析结果，再创建脚本草稿。");
      const next = { goals: { theme: "", style: "", durationSeconds: null }, sources, provider: null, feedback: "",
        content: { title: "脚本草稿", theme: "", rationale: "", suggestions: [], candidates: [],
          gaps: sources.filter(source => source.capability === "unanalysed").map(source => `素材尚无分析结果：${assets.find(asset => asset.assetId === source.assetRef.entityId)?.name || source.sourceId}`),
          classifications: sources.map(source => ({ sourceId: source.sourceId, themes: [], tags: [...source.labels], included: true, note: source.capability === "unanalysed" ? "尚无分析结果" : "" })),
          segments: sources.map(source => ({ segmentId: crypto.randomUUID(), kind: source.capability === "speech" ? "sourceSpeech" : source.kind === "audio" ? "narration" : "visual",
            sourceIds: [source.sourceId], originalText: source.capability === "speech" ? source.originalText : "",
            editedText: source.capability === "speech" ? source.originalText : "", visualSuggestion: source.visualNotes,
            estimatedDurationSeconds: source.range.sourceEndSeconds - source.range.sourceStartSeconds, included: true })) } };
      const saved = await review.save({ scriptId: crypto.randomUUID(), revision: 0 }, next);
      setRecords(values => [...values, saved]); select(saved);
    } catch (error) { setError(error.message); }
    finally { setLoading(false); }
  };
  const editSegment = (index, fields) => change(value => ({ ...value, content: { ...value.content,
    segments: value.content.segments.map((segment, position) => position === index ? { ...segment, ...fields } : segment) } }));
  const move = (index, offset) => change(value => {
    const segments = [...value.content.segments];
    [segments[index], segments[index + offset]] = [segments[index + offset], segments[index]];
    return { ...value, content: { ...value.content, segments } };
  });
  const play = async source => {
    try {
      const asset = assets.find(asset => asset.assetId === source.assetRef.entityId);
      if (!asset) throw new Error("此素材不在当前列表，请加载更多素材后重试。");
      setPreview({ asset, range: source.range, url: await analysis.source(asset) });
    } catch (error) { setError(error.message); }
  };
  const busy = loading || review.saving;
  return <section className="material-analysis" aria-label="脚本审阅">
    <h3>脚本审阅</h3>
    <PlanningControls review={review} record={record} dirty={dirty || busy} onGenerated={async () => {
      try { setRecords((await review.list()).items); } catch (error) { setError(error.message); }
    }} />
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" disabled={busy || dirty} onClick={create}>从分析结果创建草稿</button>
    <select aria-label="选择脚本" value={record?.scriptId || ""} disabled={busy || dirty} onChange={event => select(records.find(item => item.scriptId === event.target.value))}>
      <option value="" disabled>选择脚本</option>{records.map(item => <option key={item.scriptId} value={item.scriptId}>{item.draft.content.title} · 修订 {item.revision}</option>)}
    </select>
    {draft ? <>
      <p role="status">{dirty ? "有未保存修订" : busy ? "正在保存" : record.sourcesCurrent === false ? "来源已变化，需重新审阅；历史确认仍保留" : record.confirmed ? `已确认修订 ${record.revision}` : `已保存修订 ${record.revision}，待确认`}</p>
      <button type="button" disabled={busy || dirty} onClick={async () => {
        try { const next = (await review.list()).items; setRecords(next); const current = next.find(item => item.scriptId === record.scriptId); if (current) select(current); }
        catch (error) { setError(error.message); }
      }}>刷新来源状态</button>
      <button type="button" disabled={busy || dirty || !record.revision} onClick={async () => {
        try { setHistory((await review.history(record.scriptId)).items); } catch (error) { setError(error.message); }
      }}>查看修订与确认历史</button>
      {history.length ? <details open><summary>历史修订</summary>{history.map(item => <details key={item.revision}>
        <summary>修订 {item.revision} · {item.createdAt} {item.confirmed ? "· 此版本已确认" : ""}</summary>
        <p>{item.draft.content.title}</p><ol>{item.draft.content.segments.map(segment => <li key={segment.segmentId}>{segment.originalText}<br />{segment.editedText}</li>)}</ol>
      </details>)}</details> : null}
      <label>标题<input value={draft.content.title} onChange={event => change(value => ({ ...value, content: { ...value.content, title: event.target.value } }))} /></label>
      <label>目标主题（可选）<input value={draft.goals.theme} onChange={event => change(value => ({ ...value, goals: { ...value.goals, theme: event.target.value } }))} /></label>
      <label>风格（可选）<input value={draft.goals.style} onChange={event => change(value => ({ ...value, goals: { ...value.goals, style: event.target.value } }))} /></label>
      <label>目标秒数（可选）<input type="number" min="1" max="86400" value={draft.goals.durationSeconds ?? ""}
        onChange={event => change(value => ({ ...value, goals: { ...value.goals, durationSeconds: event.target.value ? Number(event.target.value) : null } }))} /></label>
      {draft.content.rationale ? <p>{draft.content.rationale}</p> : null}
      {draft.content.suggestions.map((value, index) => <p key={index}>建议：{value}</p>)}
      {draft.content.candidates.map((candidate, index) => <p key={index}>{candidate.title} · {candidate.rationale}
        <button type="button" disabled={busy || dirty} onClick={() => {
          const next = structuredClone(draft); next.goals.theme = candidate.title;
          next.feedback = `围绕候选主题重新生成：${candidate.title}`;
          setRecord({ scriptId: crypto.randomUUID(), revision: 0 }); setDraft(next); editSequence.current++; setDirty(true);
        }}>以此方向建立新草稿</button></p>)}
      <details><summary>片段分类与标签</summary>{draft.content.classifications.map((item, index) => <fieldset key={item.sourceId}>
        <legend>{item.sourceId}</legend>
        <label>主题（逗号分隔）<input value={item.themes.join(", ")} onChange={event => change(value => ({ ...value, content: { ...value.content,
          classifications: value.content.classifications.map((old, position) => position === index ? { ...old, themes: event.target.value.split(",").map(value => value.trim()).filter(Boolean) } : old) } }))} /></label>
        <label>标签（逗号分隔）<input value={item.tags.join(", ")} onChange={event => change(value => ({ ...value, content: { ...value.content,
          classifications: value.content.classifications.map((old, position) => position === index ? { ...old, tags: event.target.value.split(",").map(value => value.trim()).filter(Boolean) } : old) } }))} /></label>
        <label><input type="checkbox" checked={item.included} onChange={event => change(value => ({ ...value, content: { ...value.content,
          classifications: value.content.classifications.map((old, position) => position === index ? { ...old, included: event.target.checked } : old) } }))} />用于后续规划</label>
      </fieldset>)}</details>
      <ol>{draft.content.segments.map((segment, index) => <li key={segment.segmentId}>
        <label><input type="checkbox" checked={segment.included} onChange={event => editSegment(index, { included: event.target.checked })} />保留此段</label>
        <strong>{({ sourceSpeech: "原声", narration: "待制作旁白", visual: "画面" })[segment.kind]}</strong>
        <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
        <button type="button" disabled={index === draft.content.segments.length - 1} onClick={() => move(index, 1)}>下移</button>
        {segment.originalText ? <blockquote>{segment.originalText}</blockquote> : null}
        <label>编辑文本<textarea value={segment.editedText} onChange={event => editSegment(index, { editedText: event.target.value })} /></label>
        <label>画面建议<textarea value={segment.visualSuggestion} onChange={event => editSegment(index, { visualSuggestion: event.target.value })} /></label>
        <small>预计 {segment.estimatedDurationSeconds.toFixed(1)} 秒</small>
        {segment.sourceIds.map(id => {
          const source = draft.sources.find(item => item.sourceId === id);
          return <button type="button" key={id} onClick={() => play(source)}>回放来源 {source.range.sourceStartSeconds}–{source.range.sourceEndSeconds}</button>;
        })}
      </li>)}</ol>
      <label>优化方向<textarea value={draft.feedback} onChange={event => change(value => ({ ...value, feedback: event.target.value }))} /></label>
      {draft.content.gaps.map((gap, index) => <p key={index}>素材缺口：{gap}</p>)}
      <button type="button" disabled={busy || !dirty} onClick={() => save()}>保存修订</button>
      <button type="button" disabled={busy || dirty || record.sourcesCurrent === false || Boolean(record.confirmed)} onClick={event => save(event)}>确认此脚本版本</button>
    </> : null}
    {preview ? <div>
      {preview.asset.kind === "image" ? <img src={preview.url} alt={preview.asset.name} /> :
        <video key={`${preview.url}:${preview.range.sourceStartSeconds}:${preview.range.sourceEndSeconds}`} ref={player} src={preview.url} controls
          onLoadedMetadata={() => { player.current.currentTime = preview.range.sourceStartSeconds; }}
          onTimeUpdate={() => { if (player.current.currentTime >= preview.range.sourceEndSeconds) player.current.pause(); }} />}
      <button type="button" onClick={() => setPreview(null)}>关闭来源预览</button>
    </div> : null}
  </section>;
}
