import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import { HostError, type PageSession } from "./sessions.ts";

export function createEvents(instanceId: string) {
  let sequence = 0;
  const history: { cursor: string; line: string }[] = [];
  const subscribers = new Set<{ send: (line: string) => void; close: () => void }>();
  function publish(kind: string) {
    const event = { schemaVersion: 1, eventId: randomUUID(), sequence: ++sequence,
      cursor: randomUUID(), occurredAt: new Date().toISOString(),
      entity: { type: "application", id: instanceId }, kind, payload: {} };
    const line = `${JSON.stringify(event)}\n`;
    history.push({ cursor: event.cursor, line });
    if (history.length > 128) history.shift();
    for (const subscriber of subscribers) subscriber.send(line);
  }
  return {
    publish,
    subscribe(reply: FastifyReply, page: PageSession, after?: string) {
      const index = after ? history.findIndex((event) => event.cursor === after) : -1;
      if (after && index < 0) throw new HostError("EVENT_CURSOR_EXPIRED", 409, "Query session and components before subscribing again.");
      if (subscribers.size >= 128) throw new HostError("RESOURCE_BUSY", 429, "Too many event streams.");
      const raw = reply.raw;
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) raw.setHeader(name, value);
      }
      raw.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      reply.hijack();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(expiry); clearInterval(heartbeat);
        subscribers.delete(subscriber);
        raw.end();
      };
      const subscriber = {
        close,
        send(line: string) {
          // A slow reader reconnects by cursor instead of growing an unbounded queue.
          if (!closed && !raw.write(line)) close();
        },
      };
      const expiry = setTimeout(close, Math.max(0, Date.parse(page.expiresAt) - Date.now()));
      const heartbeat = setInterval(() => subscriber.send("\n"), 15_000);
      raw.once("close", close);
      raw.once("error", close);
      subscribers.add(subscriber);
      // A current cursor has no replay data to flush the connection headers.
      raw.flushHeaders();
      for (const event of history.slice(index + 1)) { if (closed) break; subscriber.send(event.line); }
    },
    close() { for (const subscriber of [...subscribers]) subscriber.close(); },
  };
}
