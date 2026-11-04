#!/usr/bin/env node
/**
 * Package dsh-link-menu into dist/dsh-link-menu-<version>.zip.
 *
 * The archive root is the `dsh-link-menu/` folder, so the zip extracts straight
 * into a DSH plugin directory. Entries are written in a fixed order, with fixed
 * timestamps and forward-slash separators, so packing the same sources twice
 * produces byte-identical archives.
 *
 *   node build.mjs
 *
 * No dependencies: a small ZIP writer is inlined so the script also works on a
 * machine where running .ps1 files is blocked by execution policy.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Runtime surface plus the files a user needs to install and read the license. */
const FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'package.json',
  'README.md',
  'LICENSE',
  'locale/en.json',
  'locale/zh.json',
];

/** Fixed DOS timestamp (2026-01-01 00:00:00) keeps the archive reproducible. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let value = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ -1) >>> 0;
}

for (const file of FILES) {
  if (!existsSync(join(root, file))) throw new Error(`missing file: ${file}`);
}

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const zipPath = join(dist, `${manifest.name}-${manifest.version}.zip`);
if (existsSync(zipPath)) unlinkSync(zipPath);

const local = [];
const central = [];
let offset = 0;

for (const file of FILES) {
  const name = `${manifest.name}/${file}`;
  const source = readFileSync(join(root, file));
  const deflated = deflateRawSync(source, { level: 9 });
  const crc = crc32(source);

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(8, 8); // deflate
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(deflated.length, 18);
  header.writeUInt32LE(source.length, 22);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  header.writeUInt16LE(0, 28); // extra length

  local.push(header, Buffer.from(name, 'latin1'), deflated);

  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4); // version made by
  directory.writeUInt16LE(20, 6); // version needed
  directory.writeUInt16LE(0, 8); // flags
  directory.writeUInt16LE(8, 10); // deflate
  directory.writeUInt16LE(DOS_TIME, 12);
  directory.writeUInt16LE(DOS_DATE, 14);
  directory.writeUInt32LE(crc, 16);
  directory.writeUInt32LE(deflated.length, 20);
  directory.writeUInt32LE(source.length, 24);
  directory.writeUInt16LE(Buffer.byteLength(name), 28);
  directory.writeUInt16LE(0, 30); // extra
  directory.writeUInt16LE(0, 32); // comment
  directory.writeUInt16LE(0, 34); // disk
  directory.writeUInt16LE(0, 36); // internal attributes
  directory.writeUInt32LE(0, 38); // external attributes
  directory.writeUInt32LE(offset, 42);
  central.push(directory, Buffer.from(name, 'latin1'));

  offset += header.length + Buffer.byteLength(name) + deflated.length;
}

const centralBuffer = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4); // disk
end.writeUInt16LE(0, 6); // central directory disk
end.writeUInt16LE(FILES.length, 8);
end.writeUInt16LE(FILES.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20); // comment length

const archive = Buffer.concat([...local, centralBuffer, end]);
writeFileSync(zipPath, archive);

const size = statSync(zipPath).size;
const hash = createHash('sha256').update(archive).digest('hex');
console.log(`built ${zipPath} (${size.toLocaleString('en-US')} bytes, ${FILES.length} files, sha256 ${hash})`);
