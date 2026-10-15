import { createHash, randomUUID } from "node:crypto";
import { HostError, type PageSession } from "./sessions.ts";

export function createLifecycle(instanceId: string) {
  let state = "Active";
  const subject = { action: "application.stop", subjectId: instanceId, subjectRevision: 1,
    digest: createHash("sha256").update(`application.stop:${instanceId}:1`).digest("hex") };
  const confirmations = new Map<string, { pageSessionId: string; expiresAt: number }>();
  const replays = new Map<string, { digest: string; data: { state: string } }>();
  return {
    subject,
    state: () => state,
    confirm(page: PageSession, input: typeof subject) {
      if (state !== "Active") throw new HostError("TASKS_DRAINING", 409, "Service is stopping.");
      if (input.action !== subject.action || input.subjectId !== subject.subjectId ||
          input.subjectRevision !== subject.subjectRevision || input.digest !== subject.digest) {
        throw new HostError("REFERENCE_STALE", 409, "Review the current service exit action.");
      }
      for (const [key, value] of confirmations) if (value.expiresAt <= Date.now()) confirmations.delete(key);
      if (confirmations.size >= 128) throw new HostError("RESOURCE_BUSY", 429, "Too many pending confirmations.");
      const confirmationId = randomUUID();
      const expiresAt = Math.min(Date.now() + 60_000, Date.parse(page.expiresAt));
      confirmations.set(confirmationId, { pageSessionId: page.pageSessionId, expiresAt });
      return { confirmationId, expiresAt: new Date(expiresAt).toISOString() };
    },
    exit(page: PageSession, input: { mode: string; confirmationId: string }, key: string) {
      const replayKey = `${page.pageSessionId}:${key}`;
      const digest = JSON.stringify([input.mode, input.confirmationId]);
      const existing = replays.get(replayKey);
      if (existing) {
        if (existing.digest !== digest) throw new HostError("IDEMPOTENCY_KEY_REUSED", 409, "Use a new key for a different request.");
        return { ...existing.data, replayed: true };
      }
      if (state !== "Active") throw new HostError("TASKS_DRAINING", 409, "Service is stopping.");
      const confirmation = confirmations.get(input.confirmationId);
      if (!confirmation || confirmation.pageSessionId !== page.pageSessionId || confirmation.expiresAt <= Date.now()) {
        throw new HostError("USER_CONFIRMATION_REQUIRED", 403, "Confirm stopping the local service in this page.");
      }
      confirmations.delete(input.confirmationId);
      state = "Draining";
      const data = { state };
      replays.set(replayKey, { digest, data });
      return { ...data, replayed: false };
    },
    drain() { state = "Draining"; confirmations.clear(); },
  };
}
