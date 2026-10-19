import { randomBytes, randomUUID } from "node:crypto";

export class HostError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message); this.code = code; this.status = status;
  }
}

export type PageSession = { pageSessionId: string; instanceId: string; expiresAt: string; bearer: string };

export function createSessions(instanceId: string) {
  const nonces = new Map<string, number>();
  const pages = new Map<string, PageSession>();
  const prune = () => {
    const now = Date.now();
    for (const [key, expiry] of nonces) if (expiry <= now) nonces.delete(key);
    for (const [key, page] of pages) if (Date.parse(page.expiresAt) <= now) pages.delete(key);
  };
  return {
    nonce() {
      prune();
      if (nonces.size >= 128) throw new HostError("RESOURCE_BUSY", 429, "Too many pending browser launches.");
      const nonce = randomBytes(32).toString("hex");
      nonces.set(nonce, Date.now() + 60_000);
      return nonce;
    },
    bootstrap(requestedInstance: string, nonce: string): PageSession {
      prune();
      if (requestedInstance !== instanceId) throw new HostError("INSTANCE_CHANGED", 401, "Reopen from the launcher.");
      if (!nonces.delete(nonce)) throw new HostError("BOOTSTRAP_INVALID", 401, "Launch link expired or already used.");
      if (pages.size >= 128) throw new HostError("RESOURCE_BUSY", 429, "Too many page sessions.");
      const page = { pageSessionId: randomUUID(), instanceId, bearer: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
      pages.set(page.bearer, page);
      return page;
    },
    authenticate(authorization: string | undefined): PageSession {
      prune();
      if (!authorization?.startsWith("Bearer ")) throw new HostError("AUTH_REQUIRED", 401, "Page authentication required.");
      const page = pages.get(authorization.slice(7));
      if (!page) throw new HostError("SESSION_EXPIRED", 401, "Reopen from the launcher. Keep this page to export unsaved edits.");
      page.expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      return page;
    },
    clear() { nonces.clear(); pages.clear(); },
  };
}
