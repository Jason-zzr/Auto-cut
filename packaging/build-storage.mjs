import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const execute = promisify(execFile);

export async function buildStorage(directory) {
  if (process.platform !== "darwin") throw new Error("Native project storage is not yet available on this platform.");
  const target = join(directory, "autocut-storage");
  await execute("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    fileURLToPath(new URL("../native/macos/storage.c", import.meta.url)), "-o", target], { timeout: 60_000 });
  return target;
}
