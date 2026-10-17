import { useEffect, useRef, useState } from "react";

export function PlanningControls({ review, record, dirty, onGenerated }) {
  const [config, setConfig] = useState(null), [key, setKey] = useState(""), [configured, setConfigured] = useState(false);
  const [preview, setPreview] = useState(null), [runs, setRuns] = useState([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [source, setSource] = useState("agent"), [copied, setCopied] = useState(false);
  const latest = useRef({ review, onGenerated }); latest.current = { review, onGenerated };
  const generationKey = useRef(null), seen = useRef(new Set());
  useEffect(() => {
    let active = true, timer;
    const refresh = async () => {
      try {
        const tasks = await latest.current.review.runs();
        if (!active) return;
        setRuns(tasks.items);
        for (const task of tasks.items) if (task.status === "registered" && !seen.current.has(task.taskId)) {
          seen.current.add(task.taskId); latest.current.onGenerated(task.scriptRef.entityId);
        }
      } catch (error) { if (active) setError(error.message); }
      finally { if (active) timer = setTimeout(refresh, 3000); }
    };
    latest.current.review.provider().then(value => {
      if (!active) return;
      setConfigured(value.keyConfigured);
      setConfig(value.config || { providerId: "", revision: 0, protocol: "openai", baseUrl: "", model: "",
        maxOutputTokens: 8192, maxInputBytes: 200000, timeoutSeconds: 180 });
    }).catch(error => { if (active) setError(error.message); });
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  const perform = async action => {
    setBusy(true); setError("");
    try { await action(); } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  const update = fields => { setConfig(value => ({ ...value, ...fields })); setPreview(null); };
  return <section aria-label="脚本生成服务">
    <label>生成方式<select disabled={busy} value={source} onChange={event => { setSource(event.target.value); setPreview(null); }}>
      <option value="agent">当前 Agent</option><option value="api">直接 API</option>
    </select></label>
    {source === "agent" ? <div>
      <button type="button" disabled={busy || dirty || !record} onClick={() => perform(async () => {
        await navigator.clipboard.writeText(`请使用当前编辑器的脚本规划工具，为脚本 ${record.scriptId}（修订 ${record.revision}）生成或优化一份新草稿，保留来源并保存供审阅。`);
        setCopied(true);
      })}>{copied ? "已复制，粘贴到当前 Agent" : "复制脚本生成请求"}</button>
    </div> : <><details><summary>生成服务配置</summary>
      {config ? <fieldset disabled={busy}>
        <label>来源名称<input value={config.providerId} onChange={event => update({ providerId: event.target.value })} /></label>
        <label>协议<select value={config.protocol} onChange={event => update({ protocol: event.target.value })}><option value="openai">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></label>
        <label>API 基础地址（包含版本路径）<input type="url" value={config.baseUrl} placeholder="https://服务地址/v1" onChange={event => update({ baseUrl: event.target.value })} /></label>
        <label>模型<input value={config.model} onChange={event => update({ model: event.target.value })} /></label>
        <label>API 密钥<input type="password" autoComplete="off" value={key} placeholder={configured ? "已保存；留空保留" : "输入密钥"} onChange={event => setKey(event.target.value)} /></label>
        <label>最大输出 token<input type="number" min="256" max="64000" value={config.maxOutputTokens} onChange={event => update({ maxOutputTokens: Number(event.target.value) })} /></label>
        <label>最大输入字节<input type="number" min="4096" max="2000000" value={config.maxInputBytes} onChange={event => update({ maxInputBytes: Number(event.target.value) })} /></label>
        <button type="button" onClick={event => perform(async () => {
          const { revision, ...fields } = config;
          const result = await review.saveProvider(event, { ...fields, expectedRevision: revision, apiKey: key || null });
          setKey(""); setConfig(result.config); setConfigured(result.keyConfigured); setPreview(null);
        })}>保存服务配置</button>
      </fieldset> : null}
    </details>
    <button type="button" disabled={busy || dirty || !record || !configured} onClick={() => perform(async () => {
      setPreview(await review.preview(record)); generationKey.current = crypto.randomUUID();
    })}>审阅生成／优化的外发文本</button>
    {preview ? <div>
      <p>接收服务：{preview.providerId} · {preview.destination} · 模型：{preview.model}</p>
      <p>费用未知，可能产生费用。对结果未知的请求重新生成可能重复计费。</p>
      <textarea readOnly aria-label="完整外发文本" value={preview.inputText} rows={12} />
      <button type="button" disabled={busy || dirty} onClick={event => perform(async () => {
        await review.generate(event, preview.confirmationId, generationKey.current); setPreview(null);
        setRuns((await review.runs()).items);
      })}>确认发送并生成新草稿</button>
      <button type="button" disabled={busy} onClick={() => setPreview(null)}>取消</button>
    </div> : null}</>}
    {error ? <p role="alert">{error}</p> : null}
    <ul>{runs.map(task => <li key={task.taskId}>
      {task.provider.providerId} / {task.provider.model} · {task.provider.kind === "harness" && task.status === "prepared" ? "等待 Agent 输出" : ({ prepared: "已准备", dispatched: "请求处理中", remote_unknown: "远端结果未知，未自动重发",
        output_ready: "输出已保留，待登记", registered: "已登记新草稿", failed: "输出未通过验证" })[task.status]}
      {task.error ? <span> · {task.error}</span> : null}
      {task.status === "dispatched" ? <button type="button" disabled={busy} onClick={() => perform(async () => {
        await review.taskAction(task.taskId, "cancel"); setRuns((await review.runs()).items);
      })}>停止等待（不保证远端取消）</button> : null}
      {["output_ready", "remote_unknown"].includes(task.status) ? <button type="button" disabled={busy} onClick={() => perform(async () => {
        await review.taskAction(task.taskId, "register"); setRuns((await review.runs()).items);
      })}>检查已保留输出并补登记</button> : null}
    </li>)}</ul>
  </section>;
}
