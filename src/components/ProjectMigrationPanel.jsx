import { useEffect, useRef, useState } from "react";
import "./ProjectStoragePanel.css";

const labels = { queued: "等待处理", running: "正在处理", cancel_requested: "正在停止", succeeded: "已完成",
  failed: "未完成", interrupted: "已中断", cancelled: "已取消" };

export function ProjectMigrationPanel({ project, onClose }) {
  const dialog = useRef(null), migration = project.migration;
  const [kind, setKind] = useState(migration.kind || (project.projectId ? "export" : "import"));
  const [name, setName] = useState(migration.name || project.name || "Auto-cut 项目");
  const running = ["queued", "running", "cancel_requested"].includes(migration.task?.status);
  const locked = migration.busy || migration.pending || migration.needsReconnect || running;
  useEffect(() => {
    const element = dialog.current; element.showModal();
    return () => element.close();
  }, []);
  return <dialog className="project-storage-dialog" ref={dialog} aria-labelledby="project-migration-title"
    onCancel={event => { event.preventDefault(); if (!migration.busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="project-storage-heading"><h2 id="project-migration-title">完整项目迁移</h2>
      <button type="button" disabled={migration.busy} onClick={onClose}>关闭</button></div>
    <div className="project-storage-toolbar">
      <label>操作 <select value={kind} disabled={locked} onChange={event => setKind(event.target.value)}>
        <option value="export" disabled={!project.projectId}>导出已保存项目</option><option value="import">导入项目包</option>
      </select></label>
      <label>{kind === "export" ? "项目包名称" : "新项目目录名称"} <input value={name} maxLength={150} disabled={locked}
        onChange={event => setName(event.target.value)} /></label>
      <button type="button" disabled={locked || !name.trim() || (kind === "export" && !project.projectId)}
        onClick={event => void migration.start(event, kind, name)}>{kind === "export" ? "选择位置并导出" : "选择项目包和导入位置"}</button>
    </div>
    {migration.error ? <p role="alert">{migration.error}</p> : null}
    {migration.needsReconnect ? <button type="button" disabled={migration.busy} onClick={event => void migration.control(event, "recover")}>恢复上次迁移（重新选择原位置）</button> : null}
    {migration.busy ? <p role="status">正在处理请求…</p> : null}
    {migration.task ? <section aria-label="迁移任务">
      <h3>{migration.kind === "export" ? "导出" : "导入"}：{migration.name}</h3>
      <p role="status">{labels[migration.task.status] || migration.task.status}</p>
      {migration.task.output ? <p>{migration.task.output.name}{migration.kind === "import" ? " · 可在“打开完整项目”中选择此目录。" : ""}</p> : null}
      <div className="project-storage-toolbar">
        <button type="button" disabled={migration.busy || migration.pending} onClick={event => void migration.control(event, "refresh")}>刷新状态</button>
        {["failed", "interrupted"].includes(migration.task.status) ? <button type="button" disabled={migration.busy || migration.pending}
          onClick={event => void migration.control(event, "retry")}>继续 / 重试</button> : null}
        {["queued", "running", "failed", "interrupted"].includes(migration.task.status) ? <button type="button" disabled={migration.busy || migration.pending}
          onClick={event => void migration.control(event, "cancel")}>{running ? "取消任务" : "放弃任务"}</button> : null}
      </div>
    </section> : null}
    {migration.pending && !migration.needsReconnect ? <div className="project-storage-toolbar">
      <button type="button" disabled={migration.busy} onClick={event => void migration.control(event, "repeat")}>重试未确认的请求</button>
      <button type="button" disabled={migration.busy} onClick={event => void migration.control(event, "reselect")}>重新选择并重试</button>
    </div> : null}
  </dialog>;
}
