const STORAGE_KEY = "autocut.page-session";

export async function connectHostSession() {
  if (!document.querySelector('meta[name="autocut-host"][content="1"]')) return null;
  const listeners = new Set();
  let snapshot = { connection: "connecting", session: null, components: [], error: "" };
  let credential = null;
  let cursor = "";
  const seenEvents = new Set();
  let pendingExit = null;
  let retryTimer;
  let streamController;
  let closed = false;
  const update = (changes) => {
    snapshot = { ...snapshot, ...changes };
    for (const listener of listeners) listener();
  };
  const forget = () => {
    credential = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Memory-only storage remains supported. */ }
  };
  const request = async (path, body, key, options = {}) => {
    if (!path.startsWith("/api/v1/") || new URL(path, location.origin).origin !== location.origin) {
      throw new Error("Invalid local service path.");
    }
    const headers = { "Content-Type": "application/json", "X-AutoCut-Protocol-Version": "1" };
    if (credential) headers.Authorization = `Bearer ${credential.bearer}`;
    if (key) headers["Idempotency-Key"] = key;
    if (options.revision !== undefined) {
      if (!Number.isSafeInteger(options.revision) || options.revision < 1) throw new Error("Invalid asset revision.");
      headers["If-Match"] = `"${options.revision}"`;
    }
    if (options.metadata) {
      headers["Content-Type"] = "application/octet-stream";
      const bytes = new TextEncoder().encode(JSON.stringify(options.metadata));
      headers["X-AutoCut-Import-Metadata"] = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
        .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      if (headers["X-AutoCut-Import-Metadata"].length > 8192) throw new Error("Import metadata is too large.");
    }
    const signal = options.signal || AbortSignal.timeout(options.metadata ? 300_000 : path === "/api/v1/file-selections" ? 130_000 : 10_000);
    const method = options.method || (body === undefined ? "GET" : "POST");
    const requestBody = body === undefined && method === "DELETE" ? {} : body;
    const response = await fetch(path, { method, headers,
      body: requestBody === undefined ? undefined : options.metadata ? requestBody : JSON.stringify(requestBody),
      mode: "same-origin", credentials: "omit", cache: "no-store", redirect: "error",
      signal });
    const envelope = await response.json();
    if (!response.ok || envelope.ok !== true || envelope.meta?.protocolVersion !== 1) {
      const code = envelope.error?.code || "SERVICE_NOT_READY";
      if (code === "SESSION_EXPIRED" || code === "INSTANCE_CHANGED" || code === "AUTH_REQUIRED") {
        forget(); update({ connection: "expired" });
      }
      throw Object.assign(new Error(envelope.error?.message || "Local service request failed."), { code });
    }
    return envelope.data;
  };
  const refresh = async () => {
    if (closed) return;
    const session = await request("/api/v1/session");
    if (closed) return;
    if (!credential || session.instanceId !== credential.instanceId || session.pageSessionId !== credential.pageSessionId) {
      forget();
      update({ connection: "expired" });
      throw new Error("Instance changed. Reopen from the launcher; keep this page to export edits.");
    }
    const components = await request("/api/v1/components");
    if (closed) return;
    if (!Array.isArray(components.items)) throw new Error("Invalid component response.");
    update({ session, components: components.items, connection: session.state === "Draining" ? "draining" : "connected", error: "" });
  };

  const fragment = new URLSearchParams(location.hash.slice(1));
  const nonce = fragment.get("bootstrap");
  const instanceId = fragment.get("instance");
  if (nonce !== null || instanceId !== null) {
    fragment.delete("bootstrap"); fragment.delete("instance");
    const rest = fragment.toString();
    history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
    forget();
    credential = await request("/api/v1/sessions/bootstrap", { instanceId, bootstrapNonce: nonce });
    if (typeof credential?.bearer !== "string" || credential.instanceId !== instanceId ||
        typeof credential.pageSessionId !== "string" || !Number.isFinite(Date.parse(credential.expiresAt))) {
      forget(); throw new Error("Invalid page session response.");
    }
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credential)); } catch { /* Keep the capability only in memory. */ }
  } else {
    try { credential = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null"); } catch { credential = null; }
  }
  if (!credential || typeof credential.bearer !== "string" ||
      !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) {
    forget(); throw new Error("请从 Auto-cut 启动器重新打开页面。当前链接无有效会话。 / Reopen from the Auto-cut launcher.");
  }
  await refresh();

  const mediaCredential = (event) => {
    if (event.source !== navigator.serviceWorker?.controller ||
        event.data?.type !== "AUTOCUT_MEDIA_CREDENTIAL" ||
        typeof event.data.requestId !== "string" || !event.ports[0]) return;
    const port = event.ports[0];
    port.postMessage({ requestId: event.data.requestId,
      bearer: !closed && credential && Date.parse(credential.expiresAt) > Date.now() ? credential.bearer : null });
    port.close();
  };
  navigator.serviceWorker?.addEventListener("message", mediaCredential);

  async function subscribe() {
    if (closed || !credential) return;
    streamController = new AbortController();
    let connectionTimer;
    let reader;
    try {
      await refresh();
      if (closed || !credential) return;
      connectionTimer = setTimeout(() => streamController.abort(), 10_000);
      const response = await fetch(`/api/v1/events${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, {
        headers: { Authorization: `Bearer ${credential.bearer}`, "X-AutoCut-Protocol-Version": "1", "Content-Type": "application/json" },
        mode: "same-origin", credentials: "omit", redirect: "error", cache: "no-store", signal: streamController.signal,
      });
      clearTimeout(connectionTimer);
      if (!response.ok) {
        const envelope = await response.json();
        if (envelope.error?.code === "EVENT_CURSOR_EXPIRED") { cursor = ""; seenEvents.clear(); }
        if (response.status === 401) { forget(); update({ connection: "expired" }); }
        throw new Error("Local service event stream is unavailable.");
      }
      if (!response.body) throw new Error("Local service returned no event stream.");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 65536) throw new Error("Invalid event frame size.");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.schemaVersion !== 1 || typeof event.eventId !== "string" || typeof event.cursor !== "string" ||
              !Number.isInteger(event.sequence) || event.entity?.id !== credential?.instanceId) throw new Error("Invalid service event.");
          cursor = event.cursor;
          if (seenEvents.has(event.eventId)) continue;
          seenEvents.add(event.eventId);
          if (seenEvents.size > 128) seenEvents.delete(seenEvents.values().next().value);
          await refresh();
        }
      }
      if (!closed) throw new Error("Local service disconnected. Existing edits remain in this page.");
    } catch (error) {
      if (!closed) update({ connection: credential ? "disconnected" : "expired",
        error: error instanceof Error ? error.message : "Local service unavailable." });
    } finally {
      clearTimeout(connectionTimer);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (!closed && credential) retryTimer = setTimeout(() => { void subscribe(); }, 3000);
    }
  }
  void subscribe();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh,
    request,
    upload(projectId, blob, metadata, key, signal) {
      if (!(blob instanceof Blob)) throw new Error("A media Blob is required.");
      return request(`/api/v1/projects/${encodeURIComponent(projectId)}/asset-imports`, blob, key,
        { metadata: { ...metadata, sizeBytes: blob.size }, signal });
    },
    async stop(event, isBusy, confirmationText) {
      if (!event?.isTrusted) throw new Error("Use the local service button to confirm.");
      if (isBusy()) throw new Error("Wait for the current operation or cancel it using its original controls.");
      if (!window.confirm(confirmationText)) return;
      if (!pendingExit || Date.parse(pendingExit.expiresAt) <= Date.now()) {
        await refresh();
        const confirmation = await request("/api/v1/confirmation-challenges", snapshot.session.exitSubject);
        pendingExit = { confirmationId: confirmation.confirmationId, expiresAt: confirmation.expiresAt, key: crypto.randomUUID() };
      }
      if (isBusy()) { pendingExit = null; throw new Error("The page became busy. Review the exit again later."); }
      await request("/api/v1/application/exit-requests", { mode: "normal", confirmationId: pendingExit.confirmationId }, pendingExit.key);
      // The accepted shutdown will close the stream; do not report or retry that expected disconnect.
      closed = true;
      clearTimeout(retryTimer);
      streamController?.abort();
      update({ connection: "draining", error: "" });
    },
    close() {
      closed = true; clearTimeout(retryTimer); streamController?.abort(); listeners.clear();
      navigator.serviceWorker?.removeEventListener("message", mediaCredential);
    },
  };
}
