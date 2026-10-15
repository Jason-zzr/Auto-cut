import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { timingSafeEqual } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { agentDiscoveryLinkHeader } from "../../scripts/agent-discovery.mjs";
import { inspectWebResources } from "./components.ts";
import { createSessions, HostError, type PageSession } from "./sessions.ts";
import { createEvents } from "./events.ts";
import { createLifecycle } from "./lifecycle.ts";

const text = { type: "string", minLength: 1, maxLength: 256 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object", additionalProperties: false, properties, required,
});
const meta = object({ requestId: text, protocolVersion: { const: 1 } });
const errorEnvelope = object({ ok: { const: false }, error: object({
  code: text, category: text, message: { type: "string", maxLength: 1024 },
  messageKey: text, retryable: { type: "boolean" }, action: text,
  fieldIssues: { type: "array", maxItems: 0, items: object({}) },
}), meta });
const responses = (data: unknown) => ({
  200: object({ ok: { const: true }, data, meta }),
  "4xx": errorEnvelope, "5xx": errorEnvelope,
});
const emptyQuery = object({});
const subjectSchema = object({ action: { const: "application.stop" }, subjectId: text,
  subjectRevision: { type: "integer", minimum: 1 }, digest: text });

export async function startHost(options: {
  instanceId: string; proof: string; dist: string;
  openBrowser: (url: string) => Promise<void>;
  release: () => Promise<void>;
}) {
  const web = await inspectWebResources(options.dist);
  const app = Fastify({ logger: false, disableRequestLogging: true, bodyLimit: 16_384,
    requestTimeout: 15_000, connectionTimeout: 60_000, forceCloseConnections: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });
  const sessions = createSessions(options.instanceId);
  const events = createEvents(options.instanceId);
  const lifecycle = createLifecycle(options.instanceId);
  const requestSessions = new WeakMap<FastifyRequest, PageSession>();
  let origin = "";
  let host = "";
  let ready = false;
  let closing: Promise<void> | undefined;

  const success = (request: FastifyRequest, data: unknown) => ({
    ok: true, data, meta: { requestId: request.id, protocolVersion: 1 },
  });
  const pageFor = (request: FastifyRequest) => {
    const page = requestSessions.get(request);
    if (!page) throw new HostError("AUTH_REQUIRED", 401, "Page authentication required.");
    return page;
  };
  const reopen = async () => {
    if (!ready || lifecycle.state() !== "Active") throw new HostError("SERVICE_NOT_READY", 503, "Service is not accepting browser launches.");
    const nonce = sessions.nonce();
    try { await options.openBrowser(`${origin}/#bootstrap=${nonce}&instance=${options.instanceId}`); }
    catch { throw new HostError("COMPONENT_NOT_READY", 503, "The browser could not be opened. Check ego lite on macOS or Chrome on Windows and run the launcher again."); }
  };
  const stop = () => {
    closing ??= (async () => {
      ready = false;
      lifecycle.drain();
      events.publish("application.stopping");
      events.close();
      sessions.clear();
      await app.close();
      await options.release();
    })();
    return closing;
  };

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode : 500;
    const status = error instanceof HostError ? error.status :
      error instanceof Error && "validation" in error && error.validation ? 400 :
        statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    const code = error instanceof HostError ? error.code : status < 500 ? "INVALID_ARGUMENT" : "SERVICE_NOT_READY";
    const category = status === 400 ? "invalid_input" : status === 401 ? "authentication" :
      status === 403 ? "authorization" : status === 404 ? "not_found" : status === 409 ? "conflict" :
        status === 429 ? "resource_busy" : status === 503 ? "dependency_unavailable" : "internal";
    // Fastify validation and system errors may contain paths or request values.
    reply.code(status).send({ ok: false, error: { code, category,
      message: error instanceof HostError ? error.message : "Request could not be completed.",
      messageKey: code, retryable: false, action: "review_request", fieldIssues: [],
    }, meta: { requestId: request.id, protocolVersion: 1 } });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.headers({ "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff", Link: agentDiscoveryLinkHeader });
    if (!host || request.headers.host !== host) throw new HostError("ORIGIN_REJECTED", 403, "Exact loopback Host required.");
    const path = request.url.split("?")[0];
    const browserApi = path === "/api" || path.startsWith("/api/");
    const internal = path === "/internal" || path.startsWith("/internal/");
    if (!browserApi && !internal) return;
    reply.header("Cache-Control", "no-store");
    if (request.headers["x-autocut-protocol-version"] !== "1") {
      throw new HostError("PROTOCOL_VERSION_UNSUPPORTED", 400, "Protocol version 1 is required.");
    }
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new HostError("INVALID_ARGUMENT", 400, "JSON content type required.");
    }
    if (internal) {
      if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) {
        throw new HostError("ORIGIN_REJECTED", 403, "Launcher-only route.");
      }
      const expected = Buffer.from(`Instance ${options.proof}`);
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        throw new HostError("INSTANCE_PROOF_INVALID", 401, "Instance proof required.");
      }
      return;
    }
    const requestOrigin = request.headers.origin;
    const read = request.method === "GET" || request.method === "HEAD";
    if (request.headers["sec-fetch-site"] !== "same-origin" ||
        (requestOrigin !== undefined ? requestOrigin !== origin : !read)) {
      throw new HostError("ORIGIN_REJECTED", 403, "Same-origin browser request required.");
    }
    if (path === "/api/v1/sessions/bootstrap") {
      if (!ready || lifecycle.state() !== "Active") throw new HostError("SERVICE_NOT_READY", 503, "Service is stopping.");
    } else requestSessions.set(request, sessions.authenticate(request.headers.authorization));
  });

  app.get("/healthz", { schema: { querystring: emptyQuery, response: {
    200: object({ status: { const: "ready" }, protocolVersion: { const: 1 } }),
    503: object({ status: { const: "not_ready" }, protocolVersion: { const: 1 } }),
  } } }, async (_request, reply) => {
    if (!ready || lifecycle.state() !== "Active") return reply.code(503).send({ status: "not_ready", protocolVersion: 1 });
    return { status: "ready", protocolVersion: 1 };
  });
  app.post<{ Body: { instanceId: string; bootstrapNonce: string } }>("/api/v1/sessions/bootstrap", {
    schema: { querystring: emptyQuery, body: object({ instanceId: text, bootstrapNonce: text }),
      response: responses(object({ pageSessionId: text, instanceId: text, bearer: text, expiresAt: text })) },
  }, async (request) => success(request, sessions.bootstrap(request.body.instanceId, request.body.bootstrapNonce)));
  app.get("/api/v1/session", { schema: { querystring: emptyQuery, response: responses(object({
    pageSessionId: text, instanceId: text, expiresAt: text, protocolVersion: { const: 1 },
    writableProjects: { type: "array", maxItems: 0, items: object({}) },
    state: { enum: ["Active", "Draining"] }, exitSubject: subjectSchema,
  })) } }, async (request) => {
    const { pageSessionId, instanceId, expiresAt } = pageFor(request);
    return success(request, { pageSessionId, instanceId, expiresAt, protocolVersion: 1,
      writableProjects: [], state: lifecycle.state(), exitSubject: lifecycle.subject });
  });
  app.get("/api/v1/components", { schema: { querystring: emptyQuery, response: responses(object({
    items: { type: "array", items: object({ identity: text,
      version: { type: "string", maxLength: 256 }, platform: text,
      state: { enum: ["available", "unknown"] }, detail: { type: "string", maxLength: 1024 } }) },
  })) } }, async (request) => success(request, { items: web.components }));
  app.get<{ Querystring: { after?: string } }>("/api/v1/events", {
    schema: { querystring: object({ after: text }, []), response: { "4xx": errorEnvelope, "5xx": errorEnvelope } },
  }, async (request, reply) => { events.subscribe(reply, pageFor(request), request.query.after); });
  app.post<{ Body: { instanceId: string } }>("/internal/v1/launcher/reopen", {
    schema: { querystring: emptyQuery, body: object({ instanceId: text }), response: responses(object({ instanceId: text })) },
  }, async (request) => {
    if (request.body.instanceId !== options.instanceId) throw new HostError("INSTANCE_CHANGED", 401, "Instance changed.");
    await reopen();
    return success(request, { instanceId: options.instanceId });
  });
  app.post<{ Body: typeof lifecycle.subject }>("/api/v1/confirmation-challenges", {
    schema: { querystring: emptyQuery, body: subjectSchema, response: responses(object({ confirmationId: text, expiresAt: text })) },
  }, async (request) => success(request, lifecycle.confirm(pageFor(request), request.body)));
  app.post<{ Body: { mode: string; confirmationId: string } }>("/api/v1/application/exit-requests", {
    schema: { querystring: emptyQuery, body: object({ mode: { const: "normal" }, confirmationId: text }),
      response: responses(object({ state: { const: "Draining" }, replayed: { type: "boolean" } })) },
    onResponse: async (_request, reply) => {
      if (reply.statusCode === 200) setImmediate(() => { void stop().catch(() => {
        console.error("Auto-cut could not finish instance cleanup. Inspect the previous instance before restarting.");
        process.exitCode = 1;
      }); });
    },
  }, async (request) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key.length || key.length > 128) throw new HostError("INVALID_ARGUMENT", 400, "Idempotency-Key is required.");
    return success(request, lifecycle.exit(pageFor(request), request.body, key));
  });

  await app.register(fastifyStatic, { root: options.dist, serve: false, index: false,
    dotfiles: "allow", redirect: false, maxAge: 0 });
  const serve = async (request: FastifyRequest<{ Params: { "*"?: string } }>, reply: FastifyReply) => {
    const name = request.params["*"] || "index.html";
    if (!web.files.has(name) || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new HostError("INVALID_ARGUMENT", 404, "Web resource not found.");
    }
    let path = options.dist;
    for (const part of name.split("/")) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) throw new HostError("INVALID_ARGUMENT", 403, "Linked resources are not served.");
    }
    if (name === "index.html") return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(web.html);
    return reply.sendFile(name);
  };
  app.get<{ Params: { "*"?: string } }>("/", serve);
  app.get<{ Params: { "*"?: string } }>("/*", async (request, reply) => {
    const name = request.params["*"] ?? "";
    if (name === "api" || name.startsWith("api/") || name === "internal" || name.startsWith("internal/")) {
      throw new HostError("UNSUPPORTED_CAPABILITY", 404, "This route is not implemented in the current slice.");
    }
    return serve(request, reply);
  });
  app.setNotFoundHandler(() => { throw new HostError("UNSUPPORTED_CAPABILITY", 404, "Route not found."); });
  try {
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    host = new URL(origin).host;
    ready = true;
    events.publish("application.ready");
    return { port: Number(new URL(origin).port), reopen, stop };
  } catch (error) { await app.close(); throw error; }
}
