import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.env.CORUSCANT_MODE !== 'test' || !process.env.CORUSCANT_TEST_DATA_ROOT) throw new Error('E2E server requires its explicit isolated test root.');
for (const script of ['migrate', 'init-demo']) {
  const result = spawnSync(process.execPath, [`${root}dist/node/scripts/${script}.js`], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const { createConfig } = await import('../../dist/node/server/config.js');
const { installGeneratedOrbitalCatalog } = await import('../../dist/node/tests/helpers/generated-orbital.js');
installGeneratedOrbitalCatalog(createConfig());
const { buildApp } = await import('../../dist/node/server/app.js');
const { placeFixtureFetcher, placeFixtureProvider } = await import('./planning-place-provider.mjs');
const app = await buildApp({ placeLookup: { provider: placeFixtureProvider, fetcher: placeFixtureFetcher(process.env.CORUSCANT_TEST_DATA_ROOT) } });
await app.listen({ host: app.coruscant.config.host, port: app.coruscant.config.port });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
