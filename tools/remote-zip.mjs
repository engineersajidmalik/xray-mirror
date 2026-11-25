// Reads individual files out of a remote ZIP archive with HTTP range requests,
// so only the needed entries are downloaded instead of the whole archive.
import { inflateRawSync } from "node:zlib";

async function range(url, start, end) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status !== 206) throw new Error(`HTTP ${res.status} (range requests not supported?)`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Returns Map<fileName, {offset, compressedSize, method}> for every entry. */
export async function readZipIndex(url) {
  const head = await fetch(url, { method: "HEAD" });
  const size = Number(head.headers.get("content-length"));
  if (!size) throw new Error(`Could not get the size of ${url}`);
  const tail = await range(url, Math.max(0, size - 65557), size - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("ZIP end-of-central-directory record not found");
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = await range(url, cdOffset, cdOffset + cdSize - 1);

  const entries = new Map();
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const offset = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { offset, compressedSize, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Downloads and decompresses one entry. */
export async function readZipEntry(url, entry) {
  // Local header is 30 bytes + name + extra; read generously, then slice.
  const header = await range(url, entry.offset, entry.offset + 29);
  const dataStart = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (entry.compressedSize === 0) return Buffer.alloc(0);
  const data = await range(url, dataStart, dataStart + entry.compressedSize - 1);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression method ${entry.method}`);
}
