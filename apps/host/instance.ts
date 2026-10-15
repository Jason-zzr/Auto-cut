import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type InstanceRecord = {
  instanceId: string; pid: number; startedAt: string; port: number; proofRef: string;
};

async function readPrivateFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("Invalid instance record.");
  return readFile(path, "utf8");
}

export async function claimInstance(directory: string) {
  const lock = join(directory, "instance");
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(lock);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe instance directory.");
    try {
      const record = JSON.parse(await readPrivateFile(join(lock, "ready.json"))) as InstanceRecord;
      const proof = await readPrivateFile(join(lock, "proof"));
      if (typeof record.instanceId !== "string" || record.instanceId.length !== 36 ||
          !Number.isInteger(record.pid) || record.pid <= 0 || typeof record.startedAt !== "string" ||
          !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
          record.proofRef !== "proof" || proof.length !== 64) throw new Error("Invalid instance identity.");
      const response = await fetch(`http://127.0.0.1:${record.port}/internal/v1/launcher/reopen`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", "X-AutoCut-Protocol-Version": "1", Authorization: `Instance ${proof}` },
        body: JSON.stringify({ instanceId: record.instanceId }),
      });
      const result = await response.json();
      if (!response.ok || typeof result !== "object" || result === null ||
          !("ok" in result) || result.ok !== true || !("data" in result) ||
          typeof result.data !== "object" || result.data === null ||
          !("instanceId" in result.data) || result.data.instanceId !== record.instanceId) {
        throw new Error("Instance did not confirm reopen.");
      }
      return null;
    } catch {
      throw new Error(`Cannot verify or reopen the existing instance. It may still be starting or Chrome may be unavailable. Retry after checking it. If it has crashed, verify the old process is stopped before manually recovering ${lock}. No lock was removed.`);
    }
  }
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const proof = randomBytes(32).toString("hex");
  const ownerPath = join(lock, "owner.json");
  const lockInfo = await lstat(lock);
  const ownerText = JSON.stringify({ instanceId, pid: process.pid, startedAt });
  let ownerFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    ownerFile = await open(ownerPath, "wx", 0o600);
    await ownerFile.writeFile(ownerText);
  } catch (error) {
    try {
      const currentLock = await lstat(lock);
      if (!currentLock.isDirectory() || currentLock.isSymbolicLink() ||
          currentLock.dev !== lockInfo.dev || currentLock.ino !== lockInfo.ino) {
        throw new Error("Instance directory changed; refusing cleanup.", { cause: error });
      }
      if (ownerFile) {
        const createdOwner = await ownerFile.stat();
        const currentOwner = await lstat(ownerPath);
        // A failed write may leave only a prefix, before a valid owner identity exists.
        if (!currentOwner.isFile() || currentOwner.isSymbolicLink() ||
            currentOwner.dev !== createdOwner.dev || currentOwner.ino !== createdOwner.ino ||
            currentOwner.size > Buffer.byteLength(ownerText) || !ownerText.startsWith(await readFile(ownerPath, "utf8"))) {
          throw new Error("Instance owner changed; refusing cleanup.", { cause: error });
        }
        await ownerFile.close();
        await unlink(ownerPath);
      }
      // Non-recursive removal preserves any unexpected files instead of deleting them.
      await rmdir(lock);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        `Instance owner creation failed: ${error instanceof Error ? error.message : "Unknown error."} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "Unknown error."}`);
    }
    throw error;
  } finally { await ownerFile?.close(); }
  const release = async () => {
    const owner = JSON.parse(await readPrivateFile(ownerPath));
    if (owner.instanceId !== instanceId) throw new Error("Instance ownership changed; refusing cleanup.");
    for (const name of ["ready.json", "proof", "owner.json"]) {
      try { await unlink(join(lock, name)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await rmdir(lock);
  };
  try { await writeFile(join(lock, "proof"), proof, { flag: "wx", mode: 0o600 }); }
  catch (error) { await release(); throw error; }
  return {
    instanceId, proof, release,
    publish: (port: number) => writeFile(join(lock, "ready.json"), JSON.stringify({
      instanceId, pid: process.pid, startedAt, port, proofRef: "proof",
    } satisfies InstanceRecord), { flag: "wx", mode: 0o600 }),
  };
}
