import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function machineDirectory(): Promise<string> {
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("Auto-cut host requires Node 24. No runtime was installed automatically.");
  }
  const base = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32" ? process.env.LOCALAPPDATA : undefined;
  if (!base || !isAbsolute(base)) throw new Error("Unsupported platform or missing user data directory.");
  const directory = join(base, "Auto-cut");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Auto-cut data directory.");
  if (process.platform === "darwin") {
    if (info.uid !== process.getuid?.()) throw new Error("Auto-cut data directory belongs to another user.");
    await chmod(directory, 0o700);
  } else {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable.");
    const account = process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username;
    await execute(join(systemRoot, "System32", "icacls.exe"), [directory,
      "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`], { windowsHide: true, timeout: 10_000 });
  }
  return directory;
}

export async function openBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execute("/usr/bin/open", ["-b", "com.citrolabs.ego.lite", url], { timeout: 10_000 });
    return;
  }
  if (process.platform !== "win32") throw new Error("This platform is not supported.");
  const locations = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
  for (const base of locations) {
    if (!base || !isAbsolute(base)) continue;
    const executable = join(base, "Google", "Chrome", "Application", "chrome.exe");
    try { await access(executable, constants.F_OK); } catch { continue; }
    // Chromium hands off to its existing process. Never route the URL through cmd.exe.
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [url], { detached: true, stdio: "ignore", windowsHide: false });
      child.once("error", () => reject(new Error("Chrome could not be opened.")));
      child.once("spawn", () => { child.unref(); resolve(); });
    });
    return;
  }
  throw new Error("Google Chrome was not found. Install it before reopening Auto-cut.");
}
