import { constants } from "node:fs";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";

export async function inspectWebResources(root: string) {
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Editor dist is missing or unsafe. Build the reviewed editor separately before launching.");
  const files = new Set<string>();
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Linked web resource rejected: ${name}`);
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) { await access(path, constants.R_OK); files.add(name); }
      else throw new Error(`Unsupported web resource: ${name}`);
    }
  }
  await walk(root, "");
  for (const name of ["index.html", "model-cache-sw.js"]) {
    if (!files.has(name)) throw new Error(`Required editor resource missing: ${name}`);
  }
  if (![...files].some((name) => name.startsWith("assets/") && name.endsWith(".js"))) {
    throw new Error("Compiled editor assets are missing.");
  }
  const html = await readFile(join(root, "index.html"), "utf8");
  if (!html.includes("</head>")) throw new Error("Editor HTML is invalid.");
  const elements: DefaultTreeAdapterMap["element"][] = [];
  const pending: DefaultTreeAdapterMap["node"][] = [parse(html)];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node && node.namespaceURI === "http://www.w3.org/1999/xhtml") elements.push(node);
    // Template contents and script text are not active resource elements.
    if ("childNodes" in node) pending.push(...node.childNodes.toReversed());
  }
  // Only resolve URLs here; startup checks never fetch external resources.
  const documentUrl = new URL("http://127.0.0.1/");
  const base = elements.find((node) => node.tagName === "base" && node.attrs.some((attr) => attr.name === "href"));
  const baseHref = base?.attrs.find((attr) => attr.name === "href")?.value;
  const baseUrl = URL.parse(baseHref ?? "", documentUrl) ?? documentUrl;
  for (const element of elements) {
    const attrs = new Map(element.attrs.map((attr) => [attr.name, attr.value]));
    const rel = (attrs.get("rel") ?? "").toLowerCase()
      .replaceAll("\t", " ").replaceAll("\n", " ").replaceAll("\f", " ").replaceAll("\r", " ").split(" ");
    const reference = element.tagName === "script" ? attrs.get("src") :
      element.tagName === "link" && (rel.includes("stylesheet") || rel.includes("modulepreload")) ? attrs.get("href") : undefined;
    if (reference === undefined) continue;
    const resource = URL.parse(reference, baseUrl);
    if (!resource) throw new Error(`Invalid editor resource URL: ${reference}`);
    if (resource.origin !== documentUrl.origin) continue;
    let name: string;
    try { name = decodeURIComponent(resource.pathname.slice(1)); }
    catch { throw new Error(`Invalid editor resource URL: ${reference}`); }
    if (!files.has(name) || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Required editor resource missing: ${name}`);
    }
  }
  return { files, html: html.replace("</head>", '<meta name="autocut-host" content="1"></head>'),
    components: [
      { identity: "node", version: process.versions.node, platform: process.platform,
        state: "available", detail: "Current Node runtime; packaged runtime not verified." },
      { identity: "editor-web", version: "", platform: process.platform,
        state: "available", detail: "Web files readable; browser rendering and Workers not runtime-verified." },
      { identity: "optional-models-and-plugins", version: "", platform: process.platform,
        state: "unknown", detail: "Use the original model/plugin controls. No model, GPU, license or provider readiness was checked by this host." },
    ],
  };
}
