import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConfig } from '../server/config.js';

type AssetKind = 'sans-variable' | 'mono-400' | 'mono-500' | 'ofl' | 'jpeg';
interface AssetDefinition { id: string; path: string; url: string; kind: AssetKind; credit: string; permission: string }
interface Acquisition extends AssetDefinition {
  acquiredAt: string; sha256: string; bytes: number; etag: string | null;
  lastModified: string | null; finalUrl: string; validation: Record<string, unknown>;
  alterations: 'None; original distributor bytes'; sourceCommit: null;
}
interface Manifest { version: 1; assets: Acquisition[] }

const assets: AssetDefinition[] = [
  { id: 'plex-sans-variable', path: 'public/fonts/IBMPlexSans-Variable.ttf', kind: 'sans-variable',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsans/IBMPlexSans%5Bwdth%2Cwght%5D.ttf',
    credit: 'IBM Corp.; IBM Plex Sans', permission: 'SIL OFL 1.1; reserved name Plex; preserve accompanying Sans notice.' },
  { id: 'plex-mono-400', path: 'public/fonts/IBMPlexMono-Regular.ttf', kind: 'mono-400',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/IBMPlexMono-Regular.ttf',
    credit: 'IBM Corp.; IBM Plex Mono', permission: 'SIL OFL 1.1; reserved name Plex; preserve accompanying Mono notice.' },
  { id: 'plex-mono-500', path: 'public/fonts/IBMPlexMono-Medium.ttf', kind: 'mono-500',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/IBMPlexMono-Medium.ttf',
    credit: 'IBM Corp.; IBM Plex Mono', permission: 'SIL OFL 1.1; reserved name Plex; preserve accompanying Mono notice.' },
  { id: 'plex-sans-ofl', path: 'public/fonts/OFL-IBM-Plex-Sans.txt', kind: 'ofl',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsans/OFL.txt',
    credit: 'IBM Corp.; reserved font name Plex', permission: 'Complete original SIL Open Font License 1.1 notice.' },
  { id: 'plex-mono-ofl', path: 'public/fonts/OFL-IBM-Plex-Mono.txt', kind: 'ofl',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/OFL.txt',
    credit: 'IBM Corp.; reserved font name Plex', permission: 'Complete original SIL Open Font License 1.1 notice.' },
  { id: 'nasa-earth-july-2004', path: 'public/earth/world.200407.3x5400x2700.jpg', kind: 'jpeg',
    url: 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x5400x2700.jpg',
    credit: 'NASA Earth Observatory — Blue Marble: Next Generation, July 2004; Reto Stöckli.',
    permission: 'NASA educational/informational media-use guidance with source credit; no endorsement or invented MIT/CC licence.' },
];

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fontTables(bytes: Buffer): Map<string, { offset: number; length: number }> {
  if (bytes.length < 12 || bytes.readUInt32BE(0) !== 0x00010000) throw new Error('Expected original TrueType font bytes.');
  const count = bytes.readUInt16BE(4);
  if (count < 1 || count > 128 || 12 + count * 16 > bytes.length) throw new Error('Invalid TrueType table directory.');
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const cursor = 12 + i * 16;
    const tag = bytes.toString('ascii', cursor, cursor + 4);
    const offset = bytes.readUInt32BE(cursor + 8), length = bytes.readUInt32BE(cursor + 12);
    if (offset + length > bytes.length || tables.has(tag)) throw new Error(`Invalid font table ${tag}.`);
    tables.set(tag, { offset, length });
  }
  return tables;
}

function fontNames(bytes: Buffer, table: { offset: number; length: number }): Record<string, string> {
  const view = bytes.subarray(table.offset, table.offset + table.length);
  if (view.length < 6) throw new Error('Invalid font name table.');
  const count = view.readUInt16BE(2), strings = view.readUInt16BE(4);
  if (6 + count * 12 > view.length) throw new Error('Truncated font names.');
  const names = new Map<number, { value: string; priority: number }>();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    const platform = view.readUInt16BE(at), language = view.readUInt16BE(at + 4), id = view.readUInt16BE(at + 6);
    const length = view.readUInt16BE(at + 8), offset = strings + view.readUInt16BE(at + 10);
    if (offset + length > view.length) throw new Error('Invalid font name bounds.');
    const raw = view.subarray(offset, offset + length);
    const unicode = platform === 0 || platform === 3;
    if (unicode && raw.length % 2) throw new Error('Invalid Unicode font name.');
    const value = unicode ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
    const priority = platform === 3 && language === 0x0409 ? 3 : platform === 0 ? 2 : 1;
    if (value && (!names.has(id) || names.get(id)!.priority < priority)) names.set(id, { value, priority });
  }
  return Object.fromEntries(([['family', 1], ['subfamily', 2], ['fullName', 4], ['version', 5], ['postScriptName', 6]] as const)
    .map(([label, id]) => [label, names.get(id)?.value ?? 'Not recorded']));
}

function validateFont(bytes: Buffer, kind: AssetKind): Record<string, unknown> {
  const tables = fontTables(bytes), name = tables.get('name'), os2 = tables.get('OS/2');
  if (!name || !os2 || os2.length < 8) throw new Error('Font lacks required name/weight metadata.');
  const names = fontNames(bytes, name), weight = bytes.readUInt16BE(os2.offset + 4);
  const family = names.family ?? '';
  if (kind === 'sans-variable') {
    if (!family.includes('IBM Plex Sans')) throw new Error('The downloaded variable font is not IBM Plex Sans.');
    const fvar = tables.get('fvar');
    if (!fvar || fvar.length < 16) throw new Error('The Sans asset does not expose a variable font axis.');
    const view = bytes.subarray(fvar.offset, fvar.offset + fvar.length);
    const offset = view.readUInt16BE(4), count = view.readUInt16BE(8), size = view.readUInt16BE(10);
    if (count < 1 || count > 20 || size < 20 || offset + count * size > view.length) throw new Error('Invalid variable font axes.');
    const axes: { tag: string; min: number; default: number; max: number }[] = [];
    for (let i = 0; i < count; i++) {
      const at = offset + i * size;
      axes.push({ tag: view.toString('ascii', at, at + 4), min: view.readInt32BE(at + 4) / 65536,
        default: view.readInt32BE(at + 8) / 65536, max: view.readInt32BE(at + 12) / 65536 });
    }
    const wght = axes.find((axis) => axis.tag === 'wght'), wdth = axes.find((axis) => axis.tag === 'wdth');
    if (!wght || wght.min !== 100 || wght.max !== 700 || !wdth || wdth.min !== 75 || wdth.max !== 100 || wdth.default !== 100) {
      throw new Error('Sans axes differ from the approved 100–700 weight/75–100 width source; review before changing assets.');
    }
    return { kind: 'TrueType variable', ...names, axes, supportedRequestedWeights: [400, 450, 500], browserRenderingVerified: false };
  }
  if (!family.includes('IBM Plex Mono')) throw new Error('The downloaded fixed font is not IBM Plex Mono.');
  const expected = kind === 'mono-400' ? 400 : 500;
  if (weight !== expected) throw new Error(`Mono font weight is ${weight}, not the approved ${expected}.`);
  return { kind: 'TrueType static', ...names, weight, browserRenderingVerified: false };
}

function validateJpeg(bytes: Buffer): Record<string, unknown> {
  if (bytes.length < 100 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error('Expected complete JPEG start/end markers.');
  }
  let at = 2, dimensions: { width: number; height: number; precision: number } | undefined;
  while (at < bytes.length - 2) {
    if (bytes[at++] !== 0xff) throw new Error('Invalid JPEG segment marker.');
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) throw new Error('Truncated JPEG segment.');
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) throw new Error('Invalid JPEG segment bounds.');
    if ([0xc0, 0xc1, 0xc2].includes(marker ?? -1)) {
      if (length < 8) throw new Error('Invalid JPEG frame.');
      dimensions = { precision: bytes[at + 2]!, height: bytes.readUInt16BE(at + 3), width: bytes.readUInt16BE(at + 5) };
    }
    at += length;
  }
  if (!dimensions || dimensions.width !== 5400 || dimensions.height !== 2700 || dimensions.precision !== 8) {
    throw new Error('NASA texture is not the approved 5400×2700, 8-bit global JPEG.');
  }
  return { kind: 'JPEG header/signature', ...dimensions, fullDecodeVerified: false, globeOrientationVerified: false, depictedMonth: '2004-07' };
}

function validate(bytes: Buffer, kind: AssetKind): Record<string, unknown> {
  if (kind === 'jpeg') return validateJpeg(bytes);
  if (kind === 'ofl') {
    const text = bytes.toString('utf8');
    if (!/SIL OPEN FONT LICENSE\s+Version 1\.1/i.test(text) || !/Reserved Font Name\s+["“]Plex/i.test(text) || !text.includes('IBM Corp.')) {
      throw new Error('Font licence is missing the expected OFL1.1/IBM/Plex notice.');
    }
    return { kind: 'SIL OFL 1.1 original notice', reservedName: 'Plex', copyrightHolder: 'IBM Corp.' };
  }
  return validateFont(bytes, kind);
}

async function fetchBytes(url: string): Promise<{ bytes: Buffer; response: Response }> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(45_000), headers: { 'User-Agent': 'Coruscant-local-asset-acquisition/1.0' } });
  if (!response.ok || !response.body) throw new Error(`Asset fetch failed (${response.status}) for ${url}.`);
  const limit = 32 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Asset response exceeds the acquisition limit.');
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Asset stream exceeds the acquisition limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks), response };
}

async function atomicWrite(path: string, bytes: Uint8Array, overwrite = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o644);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try {
    if (overwrite) await rename(temporary, path);
    else {
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (digest(await readFile(path)) !== digest(bytes)) throw new Error(`Refusing to replace different existing asset ${path}.`);
      }
    }
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function updateAttributions(projectRoot: string, manifest: Manifest): Promise<void> {
  const path = join(projectRoot, 'assets/ATTRIBUTIONS.md'), current = await readFile(path, 'utf8');
  const begin = '<!-- BEGIN ACQUIRED ASSETS -->', end = '<!-- END ACQUIRED ASSETS -->';
  if (current.split(begin).length !== 2 || current.split(end).length !== 2) throw new Error('Attribution acquisition markers are missing or ambiguous.');
  const rows = manifest.assets.map((item) => `| ${item.id} | ${item.path} | ${item.acquiredAt} | ${item.bytes} | \`${item.sha256}\` |`).join('\n');
  const details = manifest.assets.map((item) => `- **${item.id}:** [original source](${item.url}); ${item.credit} ${item.permission} Original bytes unchanged. Distributor metadata: ETag ${item.etag ?? 'not supplied'}; Last-Modified ${item.lastModified ?? 'not supplied'}. Validation: \`${JSON.stringify(item.validation)}\`. No unverified source commit is claimed.`).join('\n');
  const body = `\n\n| Asset | Local file | Acquired UTC | Bytes | SHA-256 |\n| --- | --- | --- | --- | --- |\n${rows}\n\n${details}\n\nBinary source validation alone is not a browser-rendering, JPEG full-decoding or globe-orientation pass. Any later renderer evidence is explicitly identified in the recorded validation; it makes no telemetry or coverage claim. Font notices remain beside the original files.\n\n`;
  const next = current.slice(0, current.indexOf(begin) + begin.length) + body + current.slice(current.indexOf(end));
  if (next !== current) await atomicWrite(path, Buffer.from(next), true);
}

/** Explicit build-time acquisition, with no runtime remote asset dependency. */
export async function fetchAssets(projectRoot: string): Promise<Manifest> {
  const manifestPath = join(projectRoot, 'public/fonts/acquisition-manifest.json');
  let manifest: Manifest = { version: 1, assets: [] };
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.assets)) throw new Error('Unsupported asset manifest.');
    manifest = parsed;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const definition of assets) {
    const destination = join(projectRoot, definition.path), existing = manifest.assets.find((item) => item.id === definition.id);
    if (existing && (existing.url !== definition.url || existing.path !== definition.path || existing.kind !== definition.kind)) {
      throw new Error(`Recorded ${definition.id} source differs from the approved definition; review before changing assets.`);
    }
    let local: Buffer | undefined;
    try { local = await readFile(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (local && existing) {
      if (digest(local) !== existing.sha256) throw new Error(`Existing ${definition.id} has changed; no overwrite or new hash was accepted.`);
      validate(local, definition.kind);
      process.stdout.write(`Verified existing ${definition.id}\n`);
      continue;
    }
    const { bytes, response } = await fetchBytes(definition.url), validation = validate(bytes, definition.kind), sha256 = digest(bytes);
    if (existing && sha256 !== existing.sha256) throw new Error(`Missing ${definition.id} now downloads different bytes; the immutable acquisition was not replaced.`);
    if (local && digest(local) !== sha256) throw new Error(`Unregistered existing ${definition.id} differs from approved-source bytes; no overwrite.`);
    await atomicWrite(destination, bytes);
    const record: Acquisition = existing ?? { ...definition, acquiredAt: new Date().toISOString(), sha256, bytes: bytes.length,
      etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), finalUrl: response.url,
      validation, alterations: 'None; original distributor bytes', sourceCommit: null };
    manifest.assets = [...manifest.assets.filter((item) => item.id !== definition.id), record];
    await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), true);
    await updateAttributions(projectRoot, manifest);
    process.stdout.write(`Acquired ${definition.id}: ${sha256}\n`);
  }
  const notice = 'NASA Earth Observatory — Blue Marble: Next Generation, July 2004; Reto Stöckli.\nStatic historical Earth texture, not live imagery or customer SAR material.\nSource: https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/\nMedia guidance: https://www.nasa.gov/nasa-brand-center/images-and-media/\nEducational/informational use with source acknowledgment; no implied endorsement.\nNo NASA logo and no invented MIT/CC licence. Original JPEG bytes unmodified.\n';
  await atomicWrite(join(projectRoot, 'public/earth/NOTICE.txt'), Buffer.from(notice));
  await updateAttributions(projectRoot, manifest);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest = await fetchAssets(createConfig().projectRoot);
  process.stdout.write(`Validated ${manifest.assets.length} original public assets/notices. Browser rendering remains a separate check.\n`);
}
