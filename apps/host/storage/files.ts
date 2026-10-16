import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HostError } from "../sessions.ts";

export class StorageIOError extends HostError {
  readonly errno: number | undefined;
  constructor(errno?: number) {
    super(errno === 17 ? "OBJECT_ID_CONFLICT" : "STORAGE_IO_FAILED", errno === 17 ? 409 : 503,
      "Project storage operation could not be confirmed.");
    this.errno = errno;
  }
}

function relativePath(path: string) {
  if (!path || path.includes("\\") || path.includes("\0") ||
      path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new HostError("PATH_OUTSIDE_PROJECT", 400, "A managed relative path is required.");
  }
  return path;
}

export async function openProjectFiles(root: string, executable: string) {
  if (process.platform !== "darwin") throw new HostError("COMPONENT_NOT_READY", 503, "Native storage is unavailable on this platform.");
  const directory = await realpath(root);
  let owner: string | undefined;
  let writesStopped = false;
  const mutations = new Map<ChildProcess, Promise<void>>();
  const ownershipLost = () => new HostError("PROJECT_WRITE_LOCKED", 409, "Project storage ownership is no longer active.");
  const launch = (operation: string, paths: string[], arguments_: string[] = []) => {
    const mutation = ["mkdir", "write", "publish", "replace", "remove", "sync"].includes(operation);
    if (mutation && writesStopped) throw ownershipLost();
    const env = { ...process.env };
    delete env.AUTOCUT_STORAGE_OWNER;
    if (mutation && owner) env.AUTOCUT_STORAGE_OWNER = owner;
    const child = spawn(executable, [operation, directory, ...paths.map(relativePath), ...arguments_], { stdio: ["pipe", "pipe", "pipe"], env });
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => { if (diagnostics.length < 1024) diagnostics += chunk.toString("utf8"); });
    const completed = new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new StorageIOError()));
      child.once("close", code => {
        if (mutation && writesStopped) return reject(ownershipLost());
        if (code === 0) return resolve();
        let errno: number | undefined;
        try { const value: unknown = JSON.parse(diagnostics); if (value && typeof value === "object" && "errno" in value && typeof value.errno === "number") errno = value.errno; } catch { /* Missing output is an unknown operation outcome. */ }
        reject(new StorageIOError(errno));
      });
    });
    // Attach immediately: startup/pipe failures may precede the caller awaiting completion.
    void completed.catch(() => {});
    if (mutation) {
      mutations.set(child, completed);
      void completed.finally(() => mutations.delete(child)).catch(() => {});
    }
    return { child, completed };
  };
  const run = async (operation: string, paths: string[], input?: Readable) => {
    const { child, completed } = launch(operation, paths);
    child.stdout.resume();
    if (input) {
      try { await pipeline(input, child.stdin); }
      catch (error) { child.kill(); await completed.catch(() => {}); throw error instanceof HostError ? error : new StorageIOError(); }
    } else child.stdin.end();
    await completed;
  };
  const files = {
    directory,
    async mkdir(path: string) {
      const parts = relativePath(path).split("/");
      for (let count = 1; count <= parts.length; count++) await run("mkdir", [parts.slice(0, count).join("/")]);
    },
    async write(path: string, input: Readable | Uint8Array | string) {
      await run("write", [path], input instanceof Readable ? input : Readable.from([input]));
    },
    async read(path: string, maximum = 64 * 1024 * 1024, operation: "read" | "list" = "read"): Promise<Buffer> {
      const { child, completed } = launch(operation, [path]);
      child.stdin.end();
      let size = 0;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of child.stdout) {
          size += chunk.length;
          if (size > maximum) throw new HostError("RESOURCE_LIMIT_EXCEEDED", 400, "Project metadata exceeds its size limit.");
          chunks.push(chunk);
        }
        await completed;
        return Buffer.concat(chunks);
      } catch (error) { child.kill(); await completed.catch(() => {}); throw error; }
    },
    async list(path: string) {
      const bytes = await files.read(path, 16 * 1024 * 1024, "list");
      return bytes.toString("utf8").split("\0").filter(Boolean).sort();
    },
    stream(path: string, start: number, length: number) {
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0) {
        throw new HostError("RANGE_NOT_SATISFIABLE", 416, "Invalid media byte range.");
      }
      return Readable.from((async function* () {
        const { child, completed } = launch("readrange", [path], [String(start), String(length)]);
        child.stdin.end();
        try {
          for await (const chunk of child.stdout) yield chunk;
          await completed;
        } finally { child.kill(); await completed.catch(() => {}); }
      })());
    },
    async copyTo(path: string, output: Writable) {
      const { child, completed } = launch("read", [path]);
      child.stdin.end();
      try { await pipeline(child.stdout, output); await completed; }
      catch (error) { child.kill(); await completed.catch(() => {}); throw error; }
    },
    publish: (from: string, to: string) => run("publish", [from, to]),
    replace: (from: string, to: string) => run("replace", [from, to]),
    sync: (path: string) => run("sync", [path]),
    async remove(object: { path: string; sizeBytes: number; sha256: string }) {
      if (!owner || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 0 || object.sha256.length !== 64 ||
          [...object.sha256].some(char => !"0123456789abcdef".includes(char))) throw ownershipLost();
      const { child, completed } = launch("remove", [object.path], [String(object.sizeBytes), object.sha256]);
      child.stdin.end(); child.stdout.resume(); await completed;
    },
    async writeJson(path: string, value: unknown, replace = false) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      const bytes = Buffer.from(JSON.stringify(value) + "\n");
      await files.write(temporary, bytes);
      try { await (replace ? files.replace(temporary, path) : files.publish(temporary, path)); }
      catch (error) {
        if (!replace && error instanceof StorageIOError && error.errno === 17) {
          try {
            if ((await files.read(path)).equals(bytes)) {
              await files.remove({ path: temporary, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
            }
          } catch { /* Preserve the publication error if verification or cleanup is unavailable. */ }
        }
        throw error;
      }
    },
    async lock(path: string, identity: { expected: string; active: string; released: string }, onLost: () => void) {
      if (owner || writesStopped) throw ownershipLost();
      const { child, completed } = launch("lock", [path], [identity.expected, identity.active, identity.released]);
      let released = false;
      child.stdin.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        let response = "";
        child.stdout.on("data", (chunk: Buffer) => {
          response += chunk.toString("utf8");
          if (response === '{"locked":true}\n') resolve();
          else if (response.length > 64 || response.includes("\n")) { child.kill(); reject(new StorageIOError()); }
        });
        void completed.then(() => reject(new StorageIOError()), reject);
      });
      owner = identity.active;
      const lost = () => {
        if (released) return;
        writesStopped = true;
        for (const mutation of mutations.keys()) mutation.kill("SIGKILL");
        onLost();
      };
      void completed.then(lost, lost);
      return async () => {
        writesStopped = true;
        await Promise.allSettled([...mutations.values()]);
        released = true; child.stdin.end("R"); await completed;
      };
    },
  };
  return files;
}

export type ProjectFiles = Awaited<ReturnType<typeof openProjectFiles>>;
