/**
 * A small zip reader for export packages (no dependency): stored and deflated entries, with limits
 * against zip bombs. ZIP64, encryption and other methods are refused.
 */

import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 300, maxEntryBytes: 25 * 1024 * 1024, maxTotalBytes: 250 * 1024 * 1024 };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError("zip64 packages are not supported");
  if (count > limits.maxEntries) throw new ZipError(`the package has more than ${limits.maxEntries} entries`);

  const entries: ZipEntry[] = [];
  let total = 0;
  let pos = dirOffset;
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL) throw new ZipError("damaged zip directory");
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new ZipError("encrypted zip entries are not supported");
    if (size > limits.maxEntryBytes) throw new ZipError(`${name} is larger than ${limits.maxEntryBytes} bytes`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError(`the package is larger than ${limits.maxTotalBytes} bytes unpacked`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) throw new ZipError(`damaged entry ${name}`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compSize);
    if (raw.length !== compSize) throw new ZipError(`entry ${name} is cut short`);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes });
      } catch {
        throw new ZipError(`entry ${name} could not be unpacked`);
      }
    } else throw new ZipError(`entry ${name} uses an unsupported compression method (${method})`);
    if (data.length !== size) throw new ZipError(`entry ${name} has the wrong size`);
    entries.push({ name, data });
  }
  return entries;
}
