import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, link, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sceneAssets, type SceneAsset } from '../demo/index.js';
import { createConfig } from '../server/config.js';

export function validateScene(asset: SceneAsset): void {
  if (asset.width !== 1600 || asset.height !== 1000 || asset.actualCollection !== null || !asset.demonstration) {
    throw new Error('Unexpected synthetic scene dimensions or provenance.');
  }
  if (!asset.content.includes('width="1600" height="1000"') || !asset.content.includes('viewBox="0 0 1600 1000"')) {
    throw new Error('Synthetic scene bytes do not declare the registered dimensions.');
  }
  if (/<(?:script|foreignObject|iframe|image)\b/i.test(asset.content) || /(?:href\s*=|@import|<!DOCTYPE|<!ENTITY)/i.test(asset.content)) {
    throw new Error('The original scene must be self-contained SVG without external content.');
  }
  if (/url\(\s*(?!#[a-zA-Z0-9_-]+\s*\))[^)]*\)/i.test(asset.content)) {
    throw new Error('Only local SVG filter/pattern references are allowed.');
  }
  if (!asset.content.includes('NOT COLLECTED') || !asset.content.includes(asset.illustrativeDate)) {
    throw new Error('The scene is missing its synthetic/date disclosure.');
  }
  if (createHash('sha256').update(asset.content).digest('hex') !== asset.sha256) {
    throw new Error('Synthetic source content does not match its registered hash.');
  }
}

/** Writes original source art only; the initializer owns all database registration. */
export async function createDemoAssets(dataRoot: string, d0: string): Promise<SceneAsset[]> {
  if (!isAbsolute(dataRoot)) throw new Error('An absolute private data root is required.');
  const assets = sceneAssets(d0);
  const sourceRoot = join(dataRoot, 'demo-source');
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  for (const asset of assets) {
    validateScene(asset);
    const destination = resolve(sourceRoot, asset.filename);
    if (destination !== join(sourceRoot, asset.filename) || asset.filename.includes('/') || asset.filename.includes('\\')) {
      throw new Error('Invalid original source filename.');
    }
    try {
      const existing = await readFile(destination);
      if (createHash('sha256').update(existing).digest('hex') !== asset.sha256) {
        throw new Error(`Existing ${asset.filename} differs from this immutable origin/recipe; it was not overwritten.`);
      }
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = join(sourceRoot, `.${asset.filename}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(asset.content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // link is exclusive: concurrent initialization cannot replace an existing version.
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(destination);
      if (createHash('sha256').update(existing).digest('hex') !== asset.sha256) {
        throw new Error(`Concurrent source creation conflicts with ${asset.filename}.`);
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  return assets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--d0');
  const d0 = index >= 0 ? process.argv[index + 1] : undefined;
  if (!d0) throw new Error('Supply --d0 with the already recorded initialization UTC instant; this command never invents a new origin.');
  const config = createConfig();
  const assets = await createDemoAssets(config.dataRoot, d0);
  process.stdout.write(`${JSON.stringify({ sourceRoot: config.sourceRoot, assets: assets.map(({ id, filename, sha256, illustrativeDate }) => ({ id, filename, sha256, illustrativeDate })) })}\n`);
}
