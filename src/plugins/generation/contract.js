export const GENERATION_PROVIDER_SCHEMA_VERSION = 1;

export const GENERATION_CAPABILITIES = new Set([
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "workflow-image",
  "workflow-video",
]);

const RUNTIMES = new Set(["browser-session", "loopback", "secure-backend"]);
const AUTH_MODES = new Set(["none", "provider-session", "user-credential", "backend"]);

export function defineGenerationProvider(definition) {
  if (definition?.schemaVersion !== GENERATION_PROVIDER_SCHEMA_VERSION) {
    throw new Error(`Unsupported generation provider schema: ${definition?.schemaVersion}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.id || "")) {
    throw new Error(`Invalid generation provider id: ${definition?.id}`);
  }
  if (!RUNTIMES.has(definition.runtime)) throw new Error(`Invalid generation provider runtime: ${definition.runtime}`);
  if (!AUTH_MODES.has(definition.auth)) throw new Error(`Invalid generation provider auth mode: ${definition.auth}`);
  if (!Array.isArray(definition.capabilities) || definition.capabilities.some((item) => !GENERATION_CAPABILITIES.has(item))) {
    throw new Error(`Invalid generation provider capabilities: ${definition.id}`);
  }
  return Object.freeze({ ...definition, capabilities: Object.freeze([...definition.capabilities]) });
}

export function createInitialConnections(providers) {
  return Object.fromEntries(providers.map((provider) => [provider.id, {
    state: "disconnected",
    endpoint: provider.defaultEndpoint || "",
    user: null,
    error: "",
    errorCode: "",
  }]));
}

export function createIdleGenerationJob() {
  return { state: "idle", providerId: "", progress: null, message: "", assetId: "" };
}

const pluginRequest = (providerId, properties) => ({
  type: "object", additionalProperties: false,
  properties: { kind: { const: "plugin" }, providerId: { const: providerId }, ...properties },
  required: ["kind", "providerId", ...Object.keys(properties)],
});
const prompt = { type: "string", minLength: 1, maxLength: 1600 };
const seed = { type: "integer", minimum: -1, maximum: Number.MAX_SAFE_INTEGER };
const webuiParameters = { prompt, negativePrompt: { type: "string" },
  width: { type: "integer", minimum: 64, multipleOf: 8 }, height: { type: "integer", minimum: 64, multipleOf: 8 },
  steps: { type: "integer", minimum: 1, maximum: 150 }, seed };

export const GENERATION_REQUEST_SCHEMA = { oneOf: [
  pluginRequest("puter", { mode: { const: "text-to-image" }, prompt: { ...prompt, maxLength: 800 }, model: { type: "string", minLength: 1, maxLength: 256 } }),
  pluginRequest("puter", { mode: { const: "text-to-video" }, prompt: { ...prompt, maxLength: 800 }, model: { type: "string", minLength: 1, maxLength: 256 },
    ratio: { enum: ["16:9", "9:16"] }, duration: { enum: [4, 8] } }),
  pluginRequest("comfyui", { workflowTemplate: { type: "string", minLength: 1 }, prompt: { type: "string", maxLength: 1600 }, negativePrompt: { type: "string" }, seed }),
  pluginRequest("webui", { mode: { const: "txt2img" }, ...webuiParameters }),
  pluginRequest("webui", { mode: { const: "img2img" }, ...webuiParameters, assetId: { type: "string", minLength: 1, maxLength: 256 } }),
] };

export function validateGenerationRequest(request) {
  const invalid = () => { throw new TypeError("Invalid plugin generation request."); };
  if (!request || typeof request !== "object" || Array.isArray(request)) invalid();
  const schema = GENERATION_REQUEST_SCHEMA.oneOf.find(entry => entry.properties.providerId.const === request.providerId
    && (!entry.properties.mode || entry.properties.mode.const === request.mode));
  if (!schema || Object.keys(request).some(key => !Object.hasOwn(schema.properties, key))
    || schema.required.some(key => !Object.hasOwn(request, key))) invalid();
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = request[key];
    if ("const" in property && value !== property.const || property.enum && !property.enum.includes(value)) invalid();
    if (property.type === "string" && (typeof value !== "string" || value.length < (property.minLength ?? 0)
      || value.length > (property.maxLength ?? Infinity))) invalid();
    if (property.type === "integer" && (!Number.isSafeInteger(value) || value < (property.minimum ?? -Infinity)
      || value > (property.maximum ?? Infinity) || property.multipleOf && value % property.multipleOf !== 0)) invalid();
  }
  if (request.providerId !== "comfyui" && !request.prompt.trim()) invalid();
  if (request.providerId === "comfyui") {
    let workflow;
    try { workflow = JSON.parse(request.workflowTemplate); } catch { invalid(); }
    workflow = workflow?.prompt && typeof workflow.prompt === "object" ? workflow.prompt : workflow;
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow) || !Object.keys(workflow).length) invalid();
  }
  return structuredClone(request);
}
