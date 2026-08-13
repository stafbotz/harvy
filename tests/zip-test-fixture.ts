import { deflateRawSync } from "node:zlib";

export interface ZipFixtureEntry {
  name: string;
  content?: string | Buffer;
  method?: 0 | 8;
  unixMode?: number;
  centralName?: string;
  crc32?: number;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
}

export function buildZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const input of entries) {
    const name = Buffer.from(input.name, "utf8");
    const centralName = Buffer.from(input.centralName ?? input.name, "utf8");
    const content = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content ?? "", "utf8");
    const method = input.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const checksum = input.crc32 ?? crc32(content);
    const compressedSize = input.declaredCompressedSize ?? compressed.length;
    const uncompressedSize = input.declaredUncompressedSize ?? content.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(centralName.length, 28);
    const directory = input.name.endsWith("/");
    const mode = input.unixMode ?? (directory ? 0o040755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, centralName);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralOffset = localOffset;
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
