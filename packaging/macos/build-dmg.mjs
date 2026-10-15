import { lstat, mkdtemp, cp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";

const { values } = parseArgs({ options: { app: { type: "string" }, out: { type: "string" } }, strict: true });
if (process.platform !== "darwin" || !values.app || !values.out) throw new Error("On macOS: --app <Auto-cut.app> --out <new file.dmg>");
const app = resolve(values.app), output = resolve(values.out);
if (!output.endsWith(".dmg")) throw new Error("Output must end in .dmg.");
const info = await lstat(app);
if (!info.isDirectory() || info.isSymbolicLink() || !app.endsWith(".app")) throw new Error("Expected an application directory.");
try { await lstat(output); throw new Error("Output already exists."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const staging = await mkdtemp(join(tmpdir(), "autocut-dmg-"));
try {
  await cp(app, join(staging, basename(app)), { recursive: true, force: false, errorOnExist: true });
  await promisify(execFile)("/usr/bin/hdiutil", ["create", "-volname", "Auto-cut", "-srcfolder", staging, "-format", "UDZO", output], { timeout: 120000 });
} finally { await rm(staging, { recursive: true, force: true }); }
console.log(`Created ${output}; signing and notarization were not performed.`);
