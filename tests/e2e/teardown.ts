import type { FullConfig } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
export default async function teardown(config: FullConfig) {
  const root = config.metadata.dataRoot as string;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('coruscant-e2e-')) throw new Error('Refusing cleanup outside the isolated E2E root.');
  await rm(root, { recursive: true, force: true });
}
