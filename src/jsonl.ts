/** Synchronous JSONL streaming, keeping UTF-8 decoding at complete line boundaries. */
import * as fs from "node:fs";

export let unreadableFileCount = 0;
const unreadableFiles = new Set<string>();

export interface JsonlOptions {
  chunkSize?: number;
  maxLines?: number;
}

export function forEachJsonlRecord(
  file: string,
  onRecord: (record: Record<string, unknown>) => void | boolean,
  options: JsonlOptions = {}
): void {
  const chunkSize = options.chunkSize ?? 1024 * 1024;
  const maxLines = options.maxLines ?? Infinity;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error("chunkSize must be a positive integer");
  if (maxLines <= 0) return;
  const failed = () => {
    if (!unreadableFiles.has(file)) {
      unreadableFiles.add(file);
      unreadableFileCount++;
    }
  };
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    failed();
    return;
  }
  try {
    const chunk = Buffer.allocUnsafe(chunkSize);
    let pending: Buffer[] = [];
    let lines = 0;
    const line = (last: Buffer): boolean => {
      const bytes = pending.length ? Buffer.concat([...pending, last]) : last;
      pending = [];
      lines++;
      let record: unknown;
      try {
        record = JSON.parse(bytes.toString("utf8"));
      } catch {
        return lines < maxLines;
      }
      if (record !== null && typeof record === "object" && !Array.isArray(record)) {
        if (onRecord(record as Record<string, unknown>) === false) return false;
      }
      return lines < maxLines;
    };
    while (true) {
      let size: number;
      try {
        size = fs.readSync(fd, chunk, 0, chunk.length, null);
      } catch {
        failed();
        return;
      }
      if (!size) {
        if (pending.length) line(Buffer.alloc(0));
        return;
      }
      let start = 0;
      for (let end = chunk.indexOf(10, start); end >= 0 && end < size; end = chunk.indexOf(10, start)) {
        if (!line(chunk.subarray(start, end))) return;
        start = end + 1;
      }
      if (start < size) pending.push(Buffer.from(chunk.subarray(start, size)));
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Append-only files older than the load start cannot contain later events. */
export function isLogFileBefore(file: string, pruneBeforeMs?: number): boolean {
  if (pruneBeforeMs === undefined || pruneBeforeMs === -Infinity) return false;
  try {
    return fs.statSync(file).mtimeMs < pruneBeforeMs;
  } catch {
    // Let the reader count and report an unreadable file.
    return false;
  }
}
