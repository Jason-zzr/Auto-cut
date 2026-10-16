import { randomUUID } from "node:crypto";
import { HostError, type PageSession } from "../sessions.ts";

type EditorSession = {
  editorSessionId: string; projectId: string; pageSessionId: string;
  mode: "read" | "write"; revision: number; expiresAt: string;
};

export function createEditorSessions() {
  const sessions = new Map<string, EditorSession>();
  const prune = () => {
    for (const [id, session] of sessions) if (Date.parse(session.expiresAt) <= Date.now()) sessions.delete(id);
  };
  const authenticate = (page: PageSession, id: string) => {
    prune();
    const session = sessions.get(id);
    if (Date.parse(page.expiresAt) <= Date.now() || !session || session.pageSessionId !== page.pageSessionId) {
      throw new HostError("EDITOR_SESSION_EXPIRED", 409, "The editor session has expired.");
    }
    return session;
  };
  const expiry = (page: PageSession) => new Date(Math.min(Date.now() + 60_000, Date.parse(page.expiresAt))).toISOString();
  return {
    acquire(page: PageSession, projectId: string, mode: "read" | "write") {
      prune();
      if (Date.parse(page.expiresAt) <= Date.now()) throw new HostError("SESSION_EXPIRED", 401, "The page session has expired.");
      for (const session of sessions.values()) {
        if (session.projectId !== projectId) continue;
        if (session.pageSessionId === page.pageSessionId && session.mode === mode) return { ...session };
        if (mode === "write" && session.mode === "write") throw new HostError("WRITE_SESSION_CONFLICT", 409, "This project is writable in another page.");
      }
      if (sessions.size >= 256) throw new HostError("RESOURCE_BUSY", 429, "Too many editor sessions.");
      const session: EditorSession = { editorSessionId: randomUUID(), projectId, pageSessionId: page.pageSessionId,
        mode, revision: 1, expiresAt: expiry(page) };
      sessions.set(session.editorSessionId, session);
      return { ...session };
    },
    renew(page: PageSession, id: string, revision: number) {
      const session = authenticate(page, id);
      if (session.revision !== revision) throw new HostError("REVISION_CONFLICT", 409, "The editor lease has changed.");
      session.revision++;
      session.expiresAt = expiry(page);
      return { ...session };
    },
    requireWrite(page: PageSession, id: string, projectId: string) {
      const session = authenticate(page, id);
      if (session.projectId !== projectId || session.mode !== "write") throw new HostError("WRITE_SESSION_REQUIRED", 409, "A current writable editor session is required.");
      return { ...session };
    },
    release(page: PageSession, id: string) { authenticate(page, id); sessions.delete(id); },
    writable(page: PageSession) {
      prune();
      return [...sessions.values()].filter(session => session.pageSessionId === page.pageSessionId && session.mode === "write").map(session => ({ ...session }));
    },
    closeProject(projectId: string) {
      for (const [id, session] of sessions) if (session.projectId === projectId) sessions.delete(id);
    },
    hasWriter(projectId: string) {
      prune();
      return [...sessions.values()].some(session => session.projectId === projectId && session.mode === "write");
    },
    clear() { sessions.clear(); },
  };
}
