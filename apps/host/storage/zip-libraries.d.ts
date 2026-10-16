declare module "yazl" {
  import { EventEmitter } from "node:events";
  import { Readable } from "node:stream";
  export class ZipFile extends EventEmitter {
    outputStream: Readable;
    addBuffer(value: Buffer, path: string, options: { compress: boolean; mode: number }): void;
    addReadStreamLazy(path: string, options: { compress: boolean; size: number; mode: number }, callback: (done: (error: Error | null, stream?: Readable) => void) => void): void;
    end(options: { forceZip64Format: boolean }): void;
  }
}
declare module "yauzl" {
  import { EventEmitter } from "node:events";
  import { Readable } from "node:stream";
  export class RandomAccessReader extends EventEmitter { _readStreamForRange(start: number, end: number): Readable; }
  export interface Entry {
    fileName: string; compressedSize: number; uncompressedSize: number; compressionMethod: number;
    generalPurposeBitFlag: number; externalFileAttributes: number;
    fileNameLength: number; fileCommentLength: number; extraFieldLength: number;
  }
  export class ZipFile extends EventEmitter {
    entryCount: number;
    eachEntry(): AsyncIterable<Entry>;
    openReadStreamPromise(entry: Entry): Promise<Readable>;
    close(): void;
  }
  export function fromRandomAccessReaderPromise(reader: RandomAccessReader, size: number,
    options: { autoClose: boolean; decodeStrings: boolean; validateEntrySizes: boolean; strictFileNames: boolean }): Promise<ZipFile>;
}
