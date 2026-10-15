import { mkdir, readFile, writeFile, copyFile, cp, lstat, readdir, chmod } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildHost } from "./build-host.mjs";
import { inspectWebResources } from "../apps/host/components.ts";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: Object.fromEntries(
  ["out", "dist", "runtime", "runtime-license", "runtime-source", "runtime-sha256", "mode"].map(name => [name, { type: "string" }])
), strict: true });
for (const name of ["out", "dist", "runtime", "runtime-license", "runtime-source", "runtime-sha256"]) {
  if (!values[name]) throw new Error(`Missing --${name}. See packaging/README.md.`);
}
const mode = values.mode ?? "sea";
if (!["sea", "runtime"].includes(mode)) throw new Error("Mode must be sea or runtime.");
if (!((process.platform === "darwin" && process.arch === "arm64") ||
      (process.platform === "win32" && process.arch === "x64"))) {
  throw new Error("Build on the target macOS arm64 or Windows x64 host.");
}
const output = resolve(values.out), dist = resolve(values.dist), runtime = resolve(values.runtime);
const insideDist = relative(dist, output);
if (!insideDist || (!insideDist.startsWith("..") && !isAbsolute(insideDist))) throw new Error("Output cannot be inside the web input.");
const source = new URL(values["runtime-source"]);
if (source.protocol !== "https:" || source.username || source.password || source.search || source.hash) {
  throw new Error("Runtime source must be an HTTPS provenance URL without credentials or query parameters.");
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const runtimeDigest = await digest(runtime);
if (runtimeDigest !== values["runtime-sha256"]) throw new Error("Runtime SHA-256 mismatch.");
const runtimeLicense = await readFile(resolve(values["runtime-license"]));
if (!runtimeLicense.length) throw new Error("Runtime license is empty.");
const runtimeEnv = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" };
const { stdout } = await execute(runtime, ["-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"],
  { env: runtimeEnv, timeout: 10000 });
const identity = JSON.parse(stdout);
if (identity.version !== process.versions.node || !identity.version.startsWith("24.") ||
    identity.platform !== process.platform || identity.arch !== process.arch) {
  throw new Error("Build Node and supplied runtime must have the same Node 24 version, platform and architecture.");
}
await inspectWebResources(dist);
let postject;
if (mode === "sea") {
  try { postject = createRequire(import.meta.url).resolve("postject/dist/cli.js"); }
  catch { throw new Error("SEA requires a reviewed local postject installation. No dependency was downloaded; runtime mode is an explicit alternative."); }
}
await mkdir(output);
const mac = process.platform === "darwin";
const application = mac ? join(output, "Auto-cut.app") : join(output, "Auto-cut");
const resources = mac ? join(application, "Contents", "Resources") : join(application, "resources");
await mkdir(dirname(resources), { recursive: true });
await buildHost(resources);
await cp(dist, join(resources, "dist"), { recursive: true, errorOnExist: true, force: false });
await inspectWebResources(join(resources, "dist"));
await writeFile(join(resources, "NODE-LICENSE"), runtimeLicense);
const appPackage = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
const executable = mac ? join(application, "Contents", "MacOS", "Auto-cut") : join(application, "Auto-cut.exe");
await mkdir(dirname(executable), { recursive: true });
if (mode === "runtime") {
  const runtimeDirectory = join(resources, "runtime");
  await mkdir(runtimeDirectory);
  const targetRuntime = join(runtimeDirectory, mac ? "node" : "node.exe");
  await copyFile(runtime, targetRuntime);
  if (mac) {
    await chmod(targetRuntime, 0o755);
    await copyFile(join(repository, "packaging/macos/launch-runtime.sh"), executable);
    await chmod(executable, 0o755);
  }
} else {
  const config = join(output, "sea-config.json"), blob = join(output, "sea-prep.blob");
  await writeFile(config, JSON.stringify({ main: join(resources, "host.cjs"), output: blob,
    disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, execArgvExtension: "none" }, null, 2));
  await execute(runtime, ["--experimental-sea-config", config], { env: runtimeEnv, timeout: 120000 });
  if (mac) {
    const { stdout: architectures } = await execute("/usr/bin/lipo", ["-archs", runtime]);
    if (architectures.trim().split(" ").filter(Boolean).length > 1) {
      await execute("/usr/bin/lipo", [runtime, "-thin", "arm64", "-output", executable]);
    } else {
      await copyFile(runtime, executable);
    }
  } else {
    await copyFile(runtime, executable);
  }
  if (mac) {
    await chmod(executable, 0o755);
    await execute("/usr/bin/codesign", ["--remove-signature", executable]);
  }
  await execute(runtime, [postject, executable, "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(mac ? ["--macho-segment-name", "NODE_SEA"] : [])], { env: runtimeEnv, timeout: 120000 });
}
if (mac) {
  const template = await readFile(join(repository, "packaging/macos/Info.plist"), "utf8");
  if (appPackage.version.split(".").length !== 3 || appPackage.version.split(".").some(part => !part || String(Number(part)) !== part)) {
    throw new Error("Mac package requires a three-component numeric application version.");
  }
  await writeFile(join(application, "Contents", "Info.plist"), template.replaceAll("@VERSION@", appPackage.version));
} else {
  await copyFile(join(repository, "packaging/windows/Auto-cut.iss"), join(output, "Auto-cut.iss"));
  await writeFile(join(output, "package-defines.iss"),
    `#define AppVersion "${appPackage.version}"\n#define PackageMode "${mode}"\n`);
}
const files = [];
async function inventory(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Package contains a symbolic link.");
    if (info.isDirectory()) await inventory(path);
    else if (info.isFile()) files.push({ path: relative(application, path).split("\\").join("/"),
      sizeBytes: info.size, sha256: await digest(path) });
    else throw new Error("Package contains an unsupported file.");
  }
}
await inventory(application);
await writeFile(join(output, "package-manifest.json"), JSON.stringify({
  product: "Auto-cut", version: appPackage.version, mode, runtime: { ...identity, source: source.href, sha256: runtimeDigest },
  signing: "not-performed", files,
}, null, 2) + "\n");
console.log(`Package prepared at ${application}. Signing, installation and platform acceptance remain separate.`);
