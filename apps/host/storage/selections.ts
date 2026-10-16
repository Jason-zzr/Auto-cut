import { randomUUID } from "node:crypto";
import { lstat, realpath, open } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { Readable } from "node:stream";
import { basename } from "node:path";
import { selectLocalPaths } from "../../launcher/platform.ts";
import { HostError, type PageSession } from "../sessions.ts";

export type SelectionPurpose = "project-create" | "project-open" | "asset-import" | "migration-export" | "project-import";
type Selection = { pageSessionId: string; purpose: SelectionPurpose; paths: string[]; identities: BigIntStats[]; expiresAt: number };

function unchanged(a: BigIntStats, b: BigIntStats) {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export function createFileSelections() {
  const selections = new Map<string, Selection>();
  let choosing = false;
  return {
    async choose(page: PageSession, purpose: SelectionPurpose, multiple: boolean, mediaKinds?: ("image" | "video" | "audio")[]) {
      const directory = purpose === "project-create" || purpose === "project-open" || purpose === "migration-export";
      if (multiple && purpose !== "asset-import") throw new HostError("INVALID_ARGUMENT", 400, "This selection accepts one location.");
      const now = Date.now();
      for (const [id, item] of selections) if (item.expiresAt <= now) selections.delete(id);
      if (choosing || selections.size >= 128) throw new HostError("RESOURCE_BUSY", 429, "A file selection is already pending or the selection limit was reached.");
      choosing = true;
      try {
        const paths = await selectLocalPaths(directory ? "directory" : "file", multiple, mediaKinds);
        if (!paths.length) throw new HostError("SELECTION_CANCELLED", 409, "File selection was cancelled.");
        if (Date.parse(page.expiresAt) <= Date.now()) throw new HostError("SESSION_EXPIRED", 401, "The page session expired during selection.");
        const canonical: string[] = [];
        const identities: BigIntStats[] = [];
        for (const path of paths) {
          const info = await lstat(path, { bigint: true });
          if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
            throw new HostError("PATH_NOT_ALLOWED", 400, "Selected location has an unsupported file type.");
          }
          canonical.push(await realpath(path));
          identities.push(info);
        }
        const selectionId = randomUUID();
        const expiresAt = Math.min(Date.now() + 5 * 60_000, Date.parse(page.expiresAt));
        selections.set(selectionId, { pageSessionId: page.pageSessionId, purpose, paths: canonical, identities, expiresAt });
        return { selectionId, expiresAt: new Date(expiresAt).toISOString(), items: canonical.map(path => ({ name: basename(path), kind: directory ? "directory" : "file" })) };
      } finally { choosing = false; }
    },
    resolve(page: PageSession, id: string, purpose: SelectionPurpose) {
      const selection = selections.get(id);
      if (!selection || selection.pageSessionId !== page.pageSessionId || selection.purpose !== purpose ||
          selection.expiresAt <= Date.now() || Date.parse(page.expiresAt) <= Date.now()) {
        throw new HostError("SELECTION_EXPIRED", 409, "Select the location again.");
      }
      return [...selection.paths];
    },
    async openAsset(page: PageSession, id: string, itemIndex: number) {
      const paths = this.resolve(page, id, "asset-import");
      if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 || itemIndex >= paths.length) throw new HostError("INVALID_ARGUMENT", 400, "Selected file index is invalid.");
      const expected = selections.get(id)!.identities[itemIndex];
      const changed = () => new HostError("REFERENCE_STALE", 409, "Selected file changed. Select it again.");
      const handle = await open(paths[itemIndex], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!unchanged(expected, await handle.stat({ bigint: true }))) throw changed();
        if (expected.size <= 0n || expected.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new HostError("INVALID_ARGUMENT", 400, "Selected file size is unsupported.");
        const input = Readable.from((async function* () {
          let offset = 0;
          while (offset < Number(expected.size)) {
            const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, Number(expected.size) - offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (!bytesRead) throw changed();
            offset += bytesRead;
            yield buffer.subarray(0, bytesRead);
          }
          if (!unchanged(expected, await handle.stat({ bigint: true }))) throw changed();
        })());
        return { input, metadata: { name: basename(paths[itemIndex]), mimeType: "", sizeBytes: Number(expected.size) },
          async close() { input.destroy(); await handle.close(); } };
      } catch (error) { await handle.close(); throw error; }
    },
    async openPackage(page: PageSession, id: string) {
      const paths = this.resolve(page, id, "project-import"), expected = selections.get(id)!.identities[0];
      const changed = () => new HostError("REFERENCE_STALE", 409, "Selected project package changed. Select it again.");
      const handle = await open(paths[0], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let closed = false;
      const streams = new Set<Readable>();
      const verify = async () => {
        if (closed || !unchanged(expected, await handle.stat({ bigint: true }))) throw changed();
      };
      try {
        await verify();
        if (expected.size < 22n || expected.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new HostError("PACKAGE_INTEGRITY_FAILED", 422, "Selected package size is unsupported.");
        const sizeBytes = Number(expected.size);
        return { sizeBytes, identity: [expected.dev, expected.ino, expected.size, expected.mtimeNs, expected.ctimeNs].map(String).join(":"), verify,
          readRange(start: number, length: number) {
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start > sizeBytes - length) throw changed();
            const input = Readable.from((async function* () {
              await verify();
              let offset = start;
              while (offset < start + length) {
                const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, start + length - offset));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
                if (!bytesRead) throw changed();
                offset += bytesRead; yield buffer.subarray(0, bytesRead);
              }
              await verify();
            })());
            streams.add(input); input.once("close", () => streams.delete(input));
            return input;
          },
          async close() {
            closed = true;
            for (const stream of streams) stream.destroy();
            await handle.close();
          },
        };
      } catch (error) { await handle.close(); throw error; }
    },
    clear() { selections.clear(); },
    busy: () => choosing,
  };
}
