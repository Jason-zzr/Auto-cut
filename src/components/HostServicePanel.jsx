import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Popover } from "./ui.jsx";

export function HostServicePanel({ client, isBusy, language }) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const anchor = useRef(null);
  const currentBusy = useRef(isBusy);
  useEffect(() => { currentBusy.current = isBusy; }, [isBusy]);
  const zh = language?.startsWith("zh");
  const label = zh ? "本地服务" : "Local service";
  const connected = snapshot.connection === "connected";
  const busy = isBusy();
  const status = connected ? (zh ? "已连接" : "Connected") :
    snapshot.connection === "expired" ? (zh ? "会话过期，请重新启动入口" : "Session expired; reopen launcher") :
      snapshot.connection === "draining" ? (zh ? "正在停止" : "Stopping") : (zh ? "未连接" : "Disconnected");
  useEffect(() => {
    const warnBeforeLeaving = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, []);
  return <div className="menu-anchor" ref={anchor}>
    <button type="button" className="ghost-action" aria-expanded={open} title={`${label}: ${status}`} onClick={() => setOpen(!open)}>
      {label}{connected ? "" : " !"}
    </button>
    {open ? <Popover anchorRef={anchor} onClose={() => setOpen(false)} closeLabel={zh ? "关闭" : "Close"}>
      <div className="menu-list" style={{ minWidth: 280, maxWidth: "80vw" }}>
        <p role="status">{status}</p>
        {snapshot.components.map((item) => <div key={item.identity}>
          <strong>{item.identity}{item.version ? ` ${item.version}` : ""}</strong>
          <p>{item.state === "unknown" ? (zh ? "未核实" : "Not verified") : (zh ? "基础检查可用" : "Basic checks available")}</p>
          <small>{item.detail}</small>
        </div>)}
        {error || snapshot.error ? <p role="alert">{error || snapshot.error}</p> : null}
        <button type="button" disabled={pending || snapshot.connection === "expired"} onClick={async () => {
          setPending(true); setError("");
          try { await client.refresh(); } catch (failure) { setError(failure.message); }
          finally { setPending(false); }
        }}>{zh ? "刷新检查" : "Refresh checks"}</button>
        <button type="button" disabled={pending || busy || !connected} onClick={async (event) => {
          setPending(true); setError("");
          try {
            await client.stop(event.nativeEvent, () => currentBusy.current(), zh
              ? "停止所有页面共用的本地服务？这不会自动保存或关闭页面。请先导出需要保留的工程，并确认其他页面没有需要继续的操作；停止后资源请求可能失败。"
              : "Stop the local service shared by all pages? This does not save or close pages. Export projects you need and check other pages first; further resource requests may fail.");
          } catch (failure) { setError(failure.message); }
          finally { setPending(false); }
        }}>{zh ? "停止本地服务" : "Stop local service"}</button>
        {busy ? <small>{zh ? "请等待当前操作，或通过原控件取消。" : "Wait for the current operation or cancel it using its original controls."}</small> : null}
      </div>
    </Popover> : null}
  </div>;
}
