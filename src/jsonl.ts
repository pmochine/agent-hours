/** Synchronous JSONL reading: stream plain files, decode zstd in memory, preserve UTF-8 line boundaries. */
import * as fs from "node:fs";
import * as zlib from "node:zlib";

// Keep Node 18 support and compile against the existing Node 20 type baseline.
const zstdDecompressSync = (zlib as typeof zlib & { zstdDecompressSync?: (data: Buffer) => Buffer }).zstdDecompressSync;
export const supportsZstd = typeof zstdDecompressSync === "function";
export let compressedSkippedFileCount = 0;
const compressedSkippedFiles = new Set<string>();

export let unreadableFileCount = 0;
const unreadableFiles = new Set<string>();

export interface JsonlOptions {
  chunkSize?: number;
  maxLines?: number;
  maxBytes?: number;
  onBytesRead?: (bytes: number) => void;
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
  const compressed = file.endsWith(".zst");
  if (compressed && !supportsZstd) {
    if (!compressedSkippedFiles.has(file)) {
      compressedSkippedFiles.add(file);
      compressedSkippedFileCount++;
    }
    return;
  }
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
    let decoded: Buffer = Buffer.alloc(0);
    let decodedPosition = 0;
    let compressedBytes = Buffer.alloc(0);
    let compressedPosition = 0;
    let fileSize = 0;
    try { if (compressed) fileSize = fs.fstatSync(fd).size; }
    catch { failed(); return; }
    const budgeted = options.maxLines !== undefined || options.maxBytes !== undefined;
    const read = (length: number): number => {
      if (!compressed) return fs.readSync(fd, chunk, 0, length, null);
      while (decodedPosition >= decoded.length && (compressedPosition < fileSize || !compressedBytes.length)) {
        const target = budgeted ? Math.min(fileSize, Math.max(256 * 1024, compressedPosition * 2)) : fileSize;
        const prefix = Buffer.allocUnsafe(target);
        compressedBytes.copy(prefix);
        while (compressedPosition < target) {
          const size = fs.readSync(fd, prefix, compressedPosition, target - compressedPosition, null);
          if (!size) throw new Error("Compressed log ended during read");
          compressedPosition += size;
        }
        compressedBytes = prefix;
        // A truncated frame yields only the decoded prefix. Feed new bytes to
        // the shared line parser; never treat this prefix as a complete EOF.
        decoded = zstdDecompressSync!(compressedBytes);
        if (compressedPosition === fileSize) break;
      }
      const size = Math.min(length, decoded.length - decodedPosition);
      decoded.copy(chunk, 0, decodedPosition, decodedPosition + size);
      decodedPosition += size;
      return size;
    };
    const atEnd = (): boolean => compressed
      ? compressedPosition === fileSize && decodedPosition === decoded.length
      : fs.fstatSync(fd).size <= bytesRead;
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
    let bytesRead = 0;
    while (true) {
      const remaining = (options.maxBytes ?? Infinity) - bytesRead;
      if (remaining <= 0) {
        // At a complete EOF, retain a final record without a newline. Never
        // parse a partial line when the byte budget cuts through a record.
        try {
          if (pending.length && atEnd()) line(Buffer.alloc(0));
        } catch { failed(); }
        return;
      }
      let size: number;
      try {
        size = read(Math.min(chunk.length, remaining));
        bytesRead += size;
        options.onBytesRead?.(size);
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
