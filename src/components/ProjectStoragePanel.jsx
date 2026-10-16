import { useEffect, useRef, useState } from "react";
import { formatStorageBytes } from "../lib/modelCacheInspection.js";
import "./ProjectStoragePanel.css";

const reasons = {
  trash: "未清空", "current-save-point": "当前项目仍在使用", "previous-save-point": "上一保存点保留中",
  "migration-pin": "迁移保护中", "task-pin": "任务保护中", quarantine: "存在待处理的隔离文件",
  "pending-save": "等待保存完成", "pending-registration": "等待产物登记",
  "metadata-unavailable": "原始文件信息不完整", "metadata-unverified": "素材信息校验失败", "media-unverified": "媒体校验失败",
};

export function ProjectStoragePanel({ project, onClose }) {
  const dialog = useRef(null), latest = useRef(project);
  latest.current = project;
  const [assets, setAssets] = useState({ items: [], cursor: null });
  const [trash, setTrash] = useState({ items: [], cursor: null });
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const busy = loading || project.storageBusy;
  const refresh = async () => {
    setLoading(true); setError("");
    try {
      const [nextAssets, nextTrash] = await Promise.all([latest.current.listStorage("assets"), latest.current.listStorage("trash")]);
      setAssets(nextAssets); setTrash(nextTrash); setSelected([]);
    } catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    let active = true;
    Promise.all([latest.current.listStorage("assets"), latest.current.listStorage("trash")]).then(([nextAssets, nextTrash]) => {
      if (active) { setAssets(nextAssets); setTrash(nextTrash); }
    }).catch(failure => { if (active) setError(failure.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; element.close(); };
  }, []);
  const loadMore = async (collection) => {
    const list = collection === "assets" ? assets : trash, update = collection === "assets" ? setAssets : setTrash;
    setLoading(true); setError("");
    try {
      const next = await project.listStorage(collection, list.cursor);
      update({ items: [...list.items, ...next.items], cursor: next.cursor });
    } catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  };
  const change = async (event, action, items) => {
    setError("");
    try { await project.changeStorage(event, action, items); await refresh(); }
    catch (failure) { setError(failure.message); }
  };
  return <dialog className="project-storage-dialog" ref={dialog} aria-labelledby="project-storage-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="project-storage-heading">
      <h2 id="project-storage-title">项目素材与回收站</h2>
      <button type="button" disabled={busy} onClick={onClose} aria-label="关闭项目素材窗口">关闭</button>
    </div>
    <div className="project-storage-toolbar">
      <span>{project.name}</span><button type="button" disabled={busy} onClick={refresh}>刷新列表</button>
      {project.storagePending ? <button type="button" disabled={busy} onClick={event => change(event, "retry")}>重试上次操作</button> : null}
    </div>
    {error || project.storageError ? <p role="alert">{error || project.storageError}</p> : null}
    {busy ? <p role="status">正在处理项目素材…</p> : null}
    <section aria-label="项目素材">
      <h3>项目素材</h3>
      {!assets.items.length && !loading ? <p>暂无已保存素材</p> : null}
      <ul>{assets.items.map(item => <li key={item.assetId}>
        <div><strong>{item.name}</strong><small>{formatStorageBytes(item.sizeBytes)}</small></div>
        <button type="button" disabled={busy || project.storagePending} aria-label={`移入回收站：${item.name}`}
          onClick={event => change(event, "delete", [item])}>移入回收站</button>
      </li>)}</ul>
      {assets.cursor ? <button type="button" disabled={busy} onClick={() => loadMore("assets")}>加载更多素材</button> : null}
    </section>
    <section aria-label="项目回收站">
      <div className="project-storage-heading"><h3>回收站</h3><button type="button" disabled={busy || project.storagePending || !selected.length}
        onClick={event => change(event, "empty", trash.items.filter(item => selected.includes(item.tombstoneId)))}>清空选中项（{selected.length}）</button></div>
      {trash.items.some(item => item.purgeRequestedAt && item.mediaState !== "absent") ? <button type="button" disabled={busy || project.storagePending}
        onClick={event => change(event, "collect")}>重试释放文件</button> : null}
      {!trash.items.length && !loading ? <p>回收站为空</p> : null}
      <ul>{trash.items.map(item => <li key={item.tombstoneId}>
        <input type="checkbox" aria-label={`选择清空：${item.name}`} checked={selected.includes(item.tombstoneId)}
          disabled={busy || project.storagePending || Boolean(item.purgeRequestedAt)} onChange={event => setSelected(values => event.target.checked
            ? [...values, item.tombstoneId] : values.filter(id => id !== item.tombstoneId))} />
        <div><strong>{item.name}</strong><small>{item.purgeRequestedAt ? "已请求清空" : "可恢复"}
          {item.mediaState === "absent" ? " · 文件已不存在" : item.protectedReasons?.length ? ` · ${item.protectedReasons.map(reason => reasons[reason] || reason).join("、")}`
            : item.reclaimableBytes > 0 ? ` · 待释放 ${formatStorageBytes(item.reclaimableBytes)}` : ""}
          {item.collectionFailed ? " · 上次回收未完成，可重试" : ""}</small></div>
        <button type="button" disabled={busy || project.storagePending || !item.recoverable} aria-label={`恢复素材：${item.name}`}
          onClick={event => change(event, "restore", [item])}>恢复</button>
      </li>)}</ul>
      {trash.cursor ? <button type="button" disabled={busy} onClick={() => loadMore("trash")}>加载更多回收项</button> : null}
    </section>
  </dialog>;
}
