#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, realpath, mkdir, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(data) {
  let crc = MAX32;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ MAX32) >>> 0;
}

function classicZipSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX32) {
    throw new Error(`${label} exceeds classic ZIP limits; ZIP64 is not supported.`);
  }
}

async function collectEntries(directory, name, entries) {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${directory}`);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`Nonregular source entry: ${directory}`);
  }
  const isDirectory = stat.isDirectory();
  const zipName = isDirectory ? `${name}/` : name;
  const nameBytes = Buffer.from(zipName, 'utf8');
  if (nameBytes.length > MAX16) throw new Error(`ZIP entry name is too long: ${name}`);
  if (!isDirectory) classicZipSize(stat.size, `File ${name}`);
  const data = isDirectory ? Buffer.alloc(0) : await readFile(directory);
  classicZipSize(data.length, `File ${name}`);
  entries.push({ name: zipName, nameBytes, data, isDirectory });
  if (entries.length >= MAX16) throw new Error('Too many ZIP entries; ZIP64 is not supported.');
  if (isDirectory) {
    const children = await readdir(directory, { encoding: 'buffer' });
    children.sort(Buffer.compare);
    for (const rawName of children) {
      const child = rawName.toString('utf8');
      if (!Buffer.from(child, 'utf8').equals(rawName)) {
        throw new Error(`Source filename is not valid UTF-8 in ${directory}`);
      }
      await collectEntries(path.join(directory, child), `${name}/${child}`, entries);
    }
  }
}

function validateIdentity(entries) {
  const manifestEntry = entries.find(entry => entry.name === 'extension/manifest.json');
  const idEntry = entries.find(entry => entry.name === 'extension/ID.txt');
  if (!manifestEntry || manifestEntry.isDirectory || !idEntry || idEntry.isDirectory) {
    throw new Error('extension/manifest.json and extension/ID.txt must be regular files.');
  }
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  const key = manifest?.key;
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw new Error('manifest.key must be a nonempty base64 string.');
  }
  const keyBytes = Buffer.from(key, 'base64');
  const encoded = keyBytes.toString('base64');
  if (!keyBytes.length || (key.includes('=') ? encoded !== key : encoded.replace(/=+$/, '') !== key)) {
    throw new Error('manifest.key is not valid base64.');
  }
  const idText = idEntry.data.toString('utf8');
  const idMatch = /^([a-p]{32})(?:\r?\n)?$/.exec(idText);
  if (!idMatch || idMatch[0] !== idText) throw new Error('extension/ID.txt must contain exactly 32 characters (a-p).');
  const expectedId = createHash('sha256').update(keyBytes).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  if (idMatch[1] !== expectedId) throw new Error('extension/ID.txt does not match manifest.key.');
}

function encodeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const { nameBytes, data, isDirectory } = entry;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8; compression and DOS time remain zero.
    local.writeUInt16LE(33, 12); // 1980-01-01.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Fixed Unix origin.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    const mode = isDirectory ? 0o040755 : 0o100644;
    central.writeUInt32LE(((mode << 16) | (isDirectory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, nameBytes, data);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
    centralSize += central.length + nameBytes.length;
    classicZipSize(offset, 'Local ZIP data');
    classicZipSize(centralSize, 'ZIP central directory');
  }
  classicZipSize(offset + centralSize + 22, 'ZIP archive');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

async function resolveParent(directory) {
  try {
    return await realpath(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await resolveParent(parent), path.basename(directory));
  }
}

// Importing this module performs no filesystem writes or packaging.
export async function packageExtension({ sourceRoot = DEFAULT_ROOT, output } = {}) {
  if (typeof output !== 'string' || !output) throw new Error('An output ZIP path is required.');
  const source = path.join(path.resolve(sourceRoot), 'extension');
  const destination = path.resolve(output);
  const parent = path.dirname(destination);
  const physicalDestination = path.join(await resolveParent(parent), path.basename(destination));
  const relative = path.relative(await realpath(source), physicalDestination);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Output must be outside the source extension directory.');
  }
  try {
    await lstat(destination);
    throw new Error(`Output already exists: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!(await lstat(source)).isDirectory()) throw new Error('extension must be a directory.');
  const entries = [];
  await collectEntries(source, 'extension', entries);
  entries.sort((a, b) => Buffer.compare(a.nameBytes, b.nameBytes));
  validateIdentity(entries);
  const archive = encodeZip(entries); // Validate all ZIP limits before any writes.
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.package-extension-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o644);
  try {
    try {
      await file.writeFile(archive);
      await file.sync();
    } finally {
      await file.close();
    }
    // Hard-link publication is atomic and fails for any existing destination.
    await link(temporary, destination);
  } finally {
    await unlink(temporary);
  }
  return { output: destination, entries: entries.length, bytes: archive.length };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/package-extension.mjs [--source-root ROOT] --output FILE');
      return;
    }
    if (arg !== '--source-root' && arg !== '--output') throw new Error(`Unknown option: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[arg === '--source-root' ? 'sourceRoot' : 'output'] = value;
  }
  const result = await packageExtension(options);
  console.log(`Extension ZIP: ${result.output} (${result.entries} entries, ${result.bytes} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Extension packaging failed: ${error.message}`);
    process.exitCode = 1;
  });
}
