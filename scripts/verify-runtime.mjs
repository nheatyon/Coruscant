import { execFileSync } from 'node:child_process';

if (process.versions.node !== '24.22.1') {
  throw new Error(`Coruscant requires Node24.22.1; found ${process.version} at ${process.execPath}. Use nvm use.`);
}
const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
if (npmVersion !== '11.19.1') {
  throw new Error(`Coruscant requires npm11.19.1; found ${npmVersion}. Select the documented npm pin.`);
}
process.stdout.write(`Node ${process.version} / ${process.execPath}; npm ${npmVersion}; bundled SQLite ${process.versions.sqlite}\n`);
