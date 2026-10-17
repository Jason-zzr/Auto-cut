export function ExecutionPlanPanel({ execution, onPreview }) {
  const { record, items, scripts, busy, error, phase } = execution;
  const call = action => void Promise.resolve().then(action).catch(() => {});
  const latest = stepId => record?.attempts.findLast(attempt => attempt.stepId === stepId);
  const states = { running: "处理中", succeeded: "已完成", failed: "失败", cancelled: "已取消", cancel_requested: "正在取消",
    interrupted: "已中断", remote_status_unknown: "远端状态未知", registration_pending: "处理完成，等待结果登记" };
  return <section className="material-analysis" aria-label="处理计划">
    <h3>处理计划</h3>
    <button type="button" disabled={busy} onClick={() => call(execution.refresh)}>刷新计划与已确认脚本</button>
    <label>已保存计划<select disabled={busy} value={record?.planId ?? ""} onChange={event => execution.select(items.find(item => item.planId === event.target.value) ?? null)}>
      <option value="">选择计划</option>{items.map(item => <option key={item.planId} value={item.planId}>{item.content.intent}</option>)}
    </select></label>
    {scripts.map(script => <button key={script.scriptId} type="button" disabled={busy} onClick={() => call(() => execution.fromScript(script))}>
      准备追加脚本：{script.draft.content.title}
    </button>)}
    {error ? <p role="alert">{error}</p> : null}
    {execution.hasPending ? <button type="button" disabled={busy} onClick={event => call(() => execution.retry(event))}>重试计划记录保存</button> : null}
    {record ? <>
      <h4>{record.content.intent}</h4>
      <p>处理范围：本机执行；不上传媒体、不调用付费服务。{record.content.allowModelDownload ? "允许现有模型组件按需下载。" : "不允许下载模型组件。"}</p>
      <ol>{record.content.steps.map(step => <li key={step.stepId}>
        <strong>{step.stepId}</strong> · {step.kind} · {states[latest(step.stepId)?.status] ?? (step.dependsOn.length ? "等待依赖" : "待处理")}
        {step.dependsOn.length ? <p>依赖：{step.dependsOn.join("、")}</p> : null}
        <details><summary>处理参数</summary><pre>{JSON.stringify(step.request ?? step.operations, null, 2)}</pre></details>
        {latest(step.stepId)?.error ? <p role="alert">{latest(step.stepId).error}</p> : null}
      </li>)}</ol>
      {phase ? <p role="status">{phase}</p> : null}
      {record.application ? <p role="status">已应用。保存进度显示在顶部完整项目栏。</p> : null}
      {!record.authorization || Date.parse(record.authorization.expiresAt) <= Date.now() ? <button type="button" disabled={busy} onClick={event => call(() => execution.authorize(event))}>授权上述处理并执行</button> :
        <button type="button" disabled={busy || Boolean(record.application)} onClick={event => call(() => execution.retry(event))}>继续／重试未完成步骤</button>}
      <button type="button" disabled={!busy} onClick={execution.cancel}>取消后续处理</button>
      <button type="button" disabled={busy || Boolean(record.application) || !record.attempts.some(attempt => attempt.status === "succeeded")}
        onClick={event => call(async () => { await execution.previewResults(event); onPreview?.(); })}>预览已完成部分</button>
    </> : null}
  </section>;
}
