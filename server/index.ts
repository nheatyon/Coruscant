import { buildApp } from './app.js';

const app=await buildApp();
try { await app.listen({host:app.coruscant.config.host,port:app.coruscant.config.port}); }
catch { await app.close(); console.error('Coruscant could not start at its configured loopback address. Check the port and the documented setup steps.'); process.exitCode=1; }
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>{process.exitCode=0;});});
