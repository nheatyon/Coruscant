import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface AppConfig {
  projectRoot: string; dataRoot: string; databasePath: string; materialRoot: string;
  sourceRoot: string; clientRoot: string; host: '127.0.0.1'; port: number;
  origin: string; allowedHost: string; mode: 'demo' | 'test';
}
export interface ConfigOptions { dataRoot?: string; port?: number }

/** Resolve from the emitted module, never the caller's current directory. */
export function createConfig(options: ConfigOptions = {}): AppConfig {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const recordingRoot = resolve(projectRoot, '.local/coruscant');
  const mode = options.dataRoot !== undefined || process.env.CORUSCANT_MODE === 'test' ? 'test' : 'demo';
  if (process.env.CORUSCANT_MODE && !['test', 'demo'].includes(process.env.CORUSCANT_MODE)) {
    throw new Error('CORUSCANT_MODE must be demo or test.');
  }
  if (mode === 'demo' && process.env.CORUSCANT_TEST_DATA_ROOT) {
    throw new Error('A test data-root override is forbidden in demonstration mode.');
  }
  const chosen = options.dataRoot ?? (mode === 'test' ? process.env.CORUSCANT_TEST_DATA_ROOT : recordingRoot);
  if (!chosen || !isAbsolute(chosen)) throw new Error('Test mode requires an absolute isolated data root.');
  const dataRoot = resolve(chosen);
  if (mode === 'test' && dataRoot === recordingRoot) throw new Error('Tests cannot use the recording data root.');
  if (process.env.CORUSCANT_HOST && process.env.CORUSCANT_HOST !== '127.0.0.1') {
    throw new Error('Coruscant demonstration access binds only to 127.0.0.1.');
  }
  const port = options.port ?? Number(process.env.PORT ?? process.env.CORUSCANT_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid loopback port.');
  return { projectRoot, dataRoot, databasePath: resolve(dataRoot, 'coruscant.sqlite'),
    materialRoot: resolve(dataRoot, 'material'), sourceRoot: resolve(dataRoot, 'demo-source'),
    clientRoot: resolve(projectRoot, 'dist/client'), host: '127.0.0.1', port,
    origin: `http://127.0.0.1:${port}`, allowedHost: `127.0.0.1:${port}`, mode };
}
