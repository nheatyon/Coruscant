import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}dist/node/server/db/migrations`, { recursive: true });
for (const name of ['001-core.sql', '002-material.sql', '003-workflow.sql', '004-results.sql', '005-delivery-observations.sql', '006-orbital-catalog.sql', '007-planning.sql', '008-proposed-plans.sql']) {
  await copyFile(`${root}server/db/migrations/${name}`, `${root}dist/node/server/db/migrations/${name}`);
}
